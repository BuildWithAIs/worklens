import { fork } from "node:child_process";
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
let running = 0;
const waiting: { resume: () => void }[] = [];
const CACHE_BYTES = 16 * 1024 * 1024;
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
    .update(JSON.stringify(options))
    .digest("hex");
  const existing = cache.get(key);
  if (existing) {
    cache.delete(key);
    cache.set(key, existing);
    return existing;
  }
  if (waiting.length >= 32) throw new Error("CHAT_IMAGE_BUSY");
  if (running >= 2)
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
    const result = await new Promise<DecodedImage>((resolve, reject) => {
      const child = fork(
        fileURLToPath(new URL("./image-decoder.mjs", import.meta.url)),
        [],
        {
          execArgv: ["--max-old-space-size=128"],
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "" },
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        },
      );
      let settled = false;
      const finish = (
        value?: DecodedImage,
        error = new Error("CHAT_IMAGE_PROCESSING"),
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        child.kill("SIGKILL");
        if (value) resolve(value);
        else reject(error);
      };
      const timeout = setTimeout(
        () => finish(undefined, new Error("CHAT_IMAGE_TIMEOUT")),
        15000,
      );
      const abort = () => finish(undefined, new Error("CHAT_IMAGE_CANCELLED"));
      signal?.addEventListener("abort", abort, { once: true });
      child.once("error", () => finish());
      child.once("exit", () => finish());
      child.once(
        "message",
        (message: { result?: DecodedImage; error?: string }) => {
          const code = [
            "CHAT_IMAGE_INVALID",
            "CHAT_IMAGE_DIMENSIONS",
            "CHAT_IMAGE_REQUEST",
          ].includes(message.error ?? "")
            ? message.error
            : "CHAT_IMAGE_PROCESSING";
          finish(message.result, new Error(code));
        },
      );
      child.send(
        {
          data: image.data,
          mimeType: image.mimeType,
          options,
          pixelLimit,
        },
        (error) => {
          if (error) finish();
        },
      );
    });
    if (
      result.originalWidth * result.originalHeight > pixelLimit ||
      result.width > options.maxWidth ||
      result.height > options.maxHeight
    )
      throw new Error("CHAT_IMAGE_DIMENSIONS");
    if (result.data.length >= options.maxBytes)
      throw new Error("CHAT_IMAGE_REQUEST");
    const previous = cache.get(key);
    if (previous) {
      cachedBytes -= previous.data.length;
      cache.delete(key);
    }
    while (
      cache.size &&
      (cachedBytes + result.data.length > CACHE_BYTES || cache.size >= 64)
    ) {
      const oldest = cache.keys().next().value!;
      cachedBytes -= cache.get(oldest)!.data.length;
      cache.delete(oldest);
    }
    cache.set(key, result);
    cachedBytes += result.data.length;
    return result;
  } finally {
    const next = waiting.shift();
    if (next) next.resume();
    else running--;
  }
}
