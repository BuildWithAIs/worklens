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
}
export interface DecodedImage {
  data: string;
  mimeType: ChatImage["mimeType"];
  originalWidth: number;
  originalHeight: number;
  width: number;
  height: number;
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
  maxWidth: 25_000_000,
  maxHeight: 25_000_000,
  maxBytes: Math.ceil(CHAT_IMAGE_LIMITS.perImage / 3) * 4 + 1,
};

export async function processChatImage(
  image: { data: string; mimeType: string },
  options: ImageOptions,
  signal?: AbortSignal,
): Promise<DecodedImage> {
  signal?.throwIfAborted();
  if (image.data.length > originalOptions.maxBytes)
    throw new Error("CHAT_IMAGE_SIZE");
  const bytes = Buffer.from(image.data, "base64");
  if (bytes.length > CHAT_IMAGE_LIMITS.perImage)
    throw new Error("CHAT_IMAGE_SIZE");
  if (imageMimeType(bytes) !== image.mimeType)
    throw new Error("CHAT_IMAGE_INVALID");
  imageDimensions(bytes);
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
  if (waiting.length >= 32) throw new Error("CHAT_IMAGE_PROCESSING");
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
          execArgv: ["--max-old-space-size=128", "--wasm-max-mem-pages=6144"],
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "" },
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        },
      );
      let settled = false;
      const finish = (
        value?: DecodedImage,
        error = new Error("CHAT_IMAGE_INVALID"),
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
        () => finish(undefined, new Error("CHAT_IMAGE_PROCESSING")),
        15000,
      );
      const abort = () => finish(undefined, new Error("CHAT_IMAGE_CANCELLED"));
      signal?.addEventListener("abort", abort, { once: true });
      child.once("error", () => finish());
      child.once("exit", () => finish());
      child.once("message", (message: { result?: DecodedImage }) =>
        finish(message.result),
      );
      child.send(
        { data: image.data, mimeType: image.mimeType, options },
        (error) => {
          if (error) finish();
        },
      );
    });
    if (
      result.originalWidth * result.originalHeight > CHAT_IMAGE_LIMITS.pixels ||
      result.width > options.maxWidth ||
      result.height > options.maxHeight ||
      result.data.length >= options.maxBytes
    )
      throw new Error("CHAT_IMAGE_DIMENSIONS");
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
