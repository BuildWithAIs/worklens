import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { imageDimensions } from "../shared/image-dimensions";
import {
  CHAT_IMAGE_LIMITS,
  imageMimeType,
  type ChatImage,
} from "../shared/chat-images";

export interface ImageOptions {
  maxWidth: number;
  maxHeight: number;
  maxBytes: number;
  preserveOriginal?: boolean;
  sourceBytes?: number;
  sourcePixels?: number;
  allowGif?: boolean;
  decoderBatch?: symbol;
}
export interface DecodedImage {
  data: string;
  mimeType: ChatImage["mimeType"];
  originalWidth: number;
  originalHeight: number;
  width: number;
  height: number;
  firstFrameOnly?: boolean;
}
const cache = new Map<string, DecodedImage>();
let cachedBytes = 0;
// Requests prepare the whole history again, so remember images that failed in
// a way a retry would repeat. Expire them in case a timeout came from load.
const failures = new Map<string, { code: string; expires: number }>();
const REMEMBERED_FAILURES = [
  "CHAT_IMAGE_INVALID",
  "CHAT_IMAGE_DIMENSIONS",
  "CHAT_IMAGE_REQUEST",
  "CHAT_IMAGE_TIMEOUT",
];
const FAILURE_TTL = 10 * 60 * 1000;
let running = 0;
const waiting: { resume: () => void }[] = [];
const MAX_DECODERS = 2;
// One request can carry 22.5 MB of encoded images and up to 100 images.
// Keep enough results to reuse a full preflight in the stream guard.
const CACHE_BYTES = 24 * 1024 * 1024;
const CACHE_ENTRIES = 128;
const DECODER_MAX_JOBS = 16;
const DECODER_IDLE_MS = 500;
type Decoder = { child: ChildProcess; jobs: number };
const idleDecoders = new Map<
  symbol,
  { claim: () => Decoder; discard: () => void }
>();

function closeDecoder(child: ChildProcess) {
  child.once("error", () => {});
  child.kill("SIGKILL");
}

function takeDecoder(batch?: symbol): Decoder {
  const idle = batch && idleDecoders.get(batch);
  if (idle) return idle.claim();
  if (running + idleDecoders.size > MAX_DECODERS)
    idleDecoders.values().next().value?.discard();
  const child = fork(
    fileURLToPath(new URL("./image-decoder.mjs", import.meta.url)),
    [],
    {
      execArgv: ["--max-old-space-size=128"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "" },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );
  return { child, jobs: 0 };
}

function keepDecoder(decoder: Decoder, batch: symbol) {
  const { child } = decoder;
  const clearIdle = () => {
    idleDecoders.delete(batch);
    clearTimeout(timer);
    child.off("disconnect", discard);
    child.off("error", discard);
    child.off("exit", discard);
  };
  const claim = () => {
    clearIdle();
    child.ref();
    child.channel?.ref();
    return decoder;
  };
  const discard = () => {
    clearIdle();
    closeDecoder(child);
  };
  idleDecoders.get(batch)?.discard();
  const timer = setTimeout(discard, DECODER_IDLE_MS);
  timer.unref();
  child.once("disconnect", discard);
  child.once("error", discard);
  child.once("exit", discard);
  child.unref();
  child.channel?.unref();
  idleDecoders.set(batch, { claim, discard });
}
export const thumbnailOptions = {
  maxWidth: 256,
  maxHeight: 256,
  maxBytes: 128 * 1024,
};
export const originalOptions = {
  preserveOriginal: true,
  maxWidth: 25_000_000,
  maxHeight: 25_000_000,
  maxBytes: Math.ceil(CHAT_IMAGE_LIMITS.perImage / 3) * 4 + 1,
};
// New attachments are reduced once, before they are stored with a message.
export const attachmentOptions = {
  maxWidth: CHAT_IMAGE_LIMITS.edge,
  maxHeight: CHAT_IMAGE_LIMITS.edge,
  maxBytes: CHAT_IMAGE_LIMITS.encodedImage,
  sourceBytes: CHAT_IMAGE_LIMITS.sourceBytes,
  sourcePixels: CHAT_IMAGE_LIMITS.sourcePixels,
};

export async function processChatImage(
  image: { data: string; mimeType: string },
  options: ImageOptions,
  signal?: AbortSignal,
): Promise<DecodedImage> {
  const { decoderBatch, ...decodeOptions } = options;
  signal?.throwIfAborted();
  const sourceBytes = options.sourceBytes ?? CHAT_IMAGE_LIMITS.perImage;
  const pixelLimit = options.sourcePixels ?? CHAT_IMAGE_LIMITS.pixels;
  if (image.data.length > Math.ceil(sourceBytes / 3) * 4 + 1)
    throw new Error("CHAT_IMAGE_SIZE");
  const bytes = Buffer.from(image.data, "base64");
  if (bytes.length > sourceBytes) throw new Error("CHAT_IMAGE_SIZE");
  if (options.allowGif && image.mimeType === "image/gif") {
    // Check the logical canvas before starting the isolated, single-frame
    // decoder. GIF is accepted only for tool results, not chat uploads.
    const signature = bytes.subarray(0, 6).toString("ascii");
    if (bytes.length < 13 || !["GIF87a", "GIF89a"].includes(signature))
      throw new Error("CHAT_IMAGE_INVALID");
    const width = bytes.readUInt16LE(6),
      height = bytes.readUInt16LE(8);
    if (!width || !height) throw new Error("CHAT_IMAGE_INVALID");
    if (width * height > pixelLimit) throw new Error("CHAT_IMAGE_DIMENSIONS");
  } else {
    if (imageMimeType(bytes) !== image.mimeType)
      throw new Error("CHAT_IMAGE_INVALID");
    imageDimensions(bytes, pixelLimit);
  }
  const key = createHash("sha256")
    .update(bytes)
    .update(JSON.stringify(decodeOptions))
    .digest("hex");
  const failed = failures.get(key);
  if (failed && failed.expires > Date.now()) throw new Error(failed.code);
  if (failed) failures.delete(key);
  const existing = cache.get(key);
  if (existing) {
    cache.delete(key);
    cache.set(key, existing);
    return existing;
  }
  if (waiting.length >= 32) throw new Error("CHAT_IMAGE_BUSY");
  if (running >= MAX_DECODERS)
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        const index = waiting.indexOf(entry);
        if (index !== -1) waiting.splice(index, 1);
        reject(new Error("CHAT_IMAGE_CANCELLED"));
      };
      const entry = {
        resume: () => {
          signal?.removeEventListener("abort", abort);
          resolve();
        },
      };
      waiting.push(entry);
      signal?.addEventListener("abort", abort, { once: true });
    });
  else running++;
  try {
    signal?.throwIfAborted();
    const decoder = takeDecoder(decoderBatch);
    const { child } = decoder;
    const { result, reusable } = await new Promise<{
      result: DecodedImage;
      reusable?: boolean;
    }>((resolve, reject) => {
      let settled = false;
      const finish = (
        value?: DecodedImage,
        error = new Error("CHAT_IMAGE_PROCESSING"),
        canReuse?: boolean,
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        child.off("error", failed);
        child.off("exit", failed);
        child.off("disconnect", failed);
        child.off("message", messageReceived);
        if (value) resolve({ result: value, reusable: canReuse });
        else {
          closeDecoder(child);
          reject(error);
        }
      };
      const timeout = setTimeout(
        () => finish(undefined, new Error("CHAT_IMAGE_TIMEOUT")),
        15000,
      );
      const abort = () => finish(undefined, new Error("CHAT_IMAGE_CANCELLED"));
      const failed = () => finish();
      const messageReceived = (message: {
        result?: DecodedImage;
        error?: string;
        reusable?: boolean;
      }) => {
        const code = [
          "CHAT_IMAGE_INVALID",
          "CHAT_IMAGE_DIMENSIONS",
          "CHAT_IMAGE_REQUEST",
        ].includes(message.error ?? "")
          ? message.error
          : "CHAT_IMAGE_PROCESSING";
        finish(message.result, new Error(code), message.reusable);
      };
      signal?.addEventListener("abort", abort, { once: true });
      child.once("error", failed);
      child.once("exit", failed);
      child.once("disconnect", failed);
      child.once("message", messageReceived);
      try {
        child.send(
          {
            data: image.data,
            mimeType: image.mimeType,
            options: { ...decodeOptions, reuseDecoder: !!decoderBatch },
            pixelLimit,
          },
          (error) => {
            if (error) finish();
          },
        );
      } catch {
        finish();
      }
    });
    const invalidDimensions =
      result.originalWidth * result.originalHeight > pixelLimit ||
      result.width > options.maxWidth ||
      result.height > options.maxHeight;
    const exceedsBudget = result.data.length >= options.maxBytes;
    decoder.jobs++;
    if (
      decoderBatch &&
      reusable &&
      child.connected &&
      !invalidDimensions &&
      !exceedsBudget &&
      decoder.jobs < DECODER_MAX_JOBS
    )
      keepDecoder(decoder, decoderBatch);
    else closeDecoder(child);
    if (invalidDimensions) throw new Error("CHAT_IMAGE_DIMENSIONS");
    if (exceedsBudget) throw new Error("CHAT_IMAGE_REQUEST");
    const previous = cache.get(key);
    if (previous) {
      cachedBytes -= previous.data.length;
      cache.delete(key);
    }
    while (
      cache.size &&
      (cachedBytes + result.data.length > CACHE_BYTES ||
        cache.size >= CACHE_ENTRIES)
    ) {
      const oldest = cache.keys().next().value!;
      cachedBytes -= cache.get(oldest)!.data.length;
      cache.delete(oldest);
    }
    cache.set(key, result);
    cachedBytes += result.data.length;
    return result;
  } catch (error) {
    if (error instanceof Error && REMEMBERED_FAILURES.includes(error.message)) {
      if (failures.size >= 256) failures.delete(failures.keys().next().value!);
      failures.set(key, {
        code: error.message,
        expires: Date.now() + FAILURE_TTL,
      });
    }
    throw error;
  } finally {
    const next = waiting.shift();
    if (next) next.resume();
    else running--;
  }
}
