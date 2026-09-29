import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { imageDimensions } from "../src/shared/image-dimensions";
import {
  originalOptions,
  processChatImage,
  thumbnailOptions,
} from "../src/main/image-processing";
import { pngHeader, syntheticPng } from "./image-fixtures";
import sharp from "sharp";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, fork: vi.fn(actual.fork) };
});
beforeEach(() => {
  vi.mocked(childProcess.fork).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const input = (bytes: Buffer) => ({
  mimeType: "image/png",
  data: bytes.toString("base64"),
});

test("oversized PNG, JPEG and WebP headers are rejected before starting a decoder", async () => {
  const fork = vi.mocked(childProcess.fork);
  await expect(
    processChatImage(input(pngHeader(10000, 10000)), originalOptions),
  ).rejects.toThrow("CHAT_IMAGE_DIMENSIONS");
  const jpeg = Buffer.from([
    255, 216, 255, 192, 0, 8, 8, 0x27, 0x10, 0x27, 0x10, 1, 255, 217,
  ]);
  expect(() => imageDimensions(jpeg)).toThrow("CHAT_IMAGE_DIMENSIONS");
  const webp = Buffer.alloc(30);
  webp.write("RIFF");
  webp.writeUInt32LE(22, 4);
  webp.write("WEBPVP8X", 8);
  webp.writeUInt32LE(10, 16);
  webp.writeUIntLE(9999, 24, 3);
  webp.writeUIntLE(9999, 27, 3);
  expect(() => imageDimensions(webp)).toThrow("CHAT_IMAGE_DIMENSIONS");
  expect(fork).not.toHaveBeenCalled();
});

test("a small WebP canvas cannot conceal an oversized frame", () => {
  const bytes = Buffer.alloc(48);
  bytes.write("RIFF");
  bytes.writeUInt32LE(40, 4);
  bytes.write("WEBPVP8X", 8);
  bytes.writeUInt32LE(10, 16);
  bytes.write("VP8 ", 30);
  bytes.writeUInt32LE(10, 34);
  bytes.set([0x9d, 1, 0x2a], 41);
  bytes.writeUInt16LE(10000, 44);
  bytes.writeUInt16LE(10000, 46);
  expect(() => imageDimensions(bytes)).toThrow("CHAT_IMAGE_DIMENSIONS");
});

test("a valid long image is decoded in isolation and returned as a small thumbnail", async () => {
  const result = await processChatImage(
    input(syntheticPng(100, 9000)),
    thumbnailOptions,
  );
  expect(result.originalHeight).toBe(9000);
  expect(result.height).toBeLessThanOrEqual(256);
  expect(result.data.length).toBeLessThan(thumbnailOptions.maxBytes);
  expect(imageDimensions(Buffer.from(result.data, "base64")).height).toBe(
    result.height,
  );
});

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    kill: vi.fn(),
    send: vi.fn(),
  });
  vi.mocked(childProcess.fork).mockReturnValue(
    child as unknown as childProcess.ChildProcess,
  );
  return child;
}

test("a 24 MP phone photo is resized with EXIF orientation in the isolated decoder", async () => {
  const bytes = await sharp({
    create: { width: 5712, height: 4284, channels: 3, background: "#4389ad" },
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const image = { mimeType: "image/jpeg", data: bytes.toString("base64") };
  const result = await processChatImage(image, {
    maxWidth: 2000,
    maxHeight: 2000,
    maxBytes: 1875000,
  });
  expect([result.width, result.height]).toEqual([1500, 2000]);
  expect(imageDimensions(Buffer.from(result.data, "base64"))).toEqual({
    width: 1500,
    height: 2000,
  });
  expect(result.data.length).toBeLessThan(1875000);
  expect((await processChatImage(image, originalOptions)).data).toBe(
    image.data,
  );
});

test.each(["png", "webp"] as const)(
  "transparent %s retains alpha when resized",
  async (format) => {
    const bytes = await sharp({
      create: {
        width: 640,
        height: 400,
        channels: 4,
        background: { r: 200, g: 30, b: 70, alpha: 0.5 },
      },
    })
      .toFormat(format)
      .toBuffer();
    const result = await processChatImage(
      { mimeType: `image/${format}`, data: bytes.toString("base64") },
      thumbnailOptions,
    );
    const { data, info } = await sharp(Buffer.from(result.data, "base64"))
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(4);
    expect(data[3]).toBeGreaterThanOrEqual(127);
    expect(data[3]).toBeLessThanOrEqual(128);
  },
);

test("output budget reduces noisy images and reports an impossible budget accurately", async () => {
  const image = input(syntheticPng(640, 640, true));
  const result = await processChatImage(image, {
    maxWidth: 640,
    maxHeight: 640,
    maxBytes: 8000,
  });
  expect(result.data.length).toBeLessThan(8000);
  expect(result.width).toBeLessThan(640);
  await expect(
    processChatImage(image, { maxWidth: 640, maxHeight: 640, maxBytes: 4 }),
  ).rejects.toThrow("CHAT_IMAGE_REQUEST");
});

test("a truncated JPEG with valid dimensions is rejected even when no resize is needed", async () => {
  const bytes = await sharp(syntheticPng(80, 60, true))
    .jpeg()
    .toBuffer();
  const truncated = bytes.subarray(0, Math.floor(bytes.length * 0.8));
  expect(imageDimensions(truncated)).toEqual({ width: 80, height: 60 });
  await expect(
    processChatImage(
      { data: truncated.toString("base64"), mimeType: "image/jpeg" },
      originalOptions,
    ),
  ).rejects.toThrow("CHAT_IMAGE_INVALID");
});

test("decoder crashes are contained and never retried in the caller process", async () => {
  const child = fakeChild();
  const task = processChatImage(input(syntheticPng(11, 9)), thumbnailOptions);
  const rejection = expect(task).rejects.toThrow("CHAT_IMAGE_PROCESSING");
  child.emit("exit", 1);
  await rejection;
  expect(childProcess.fork).toHaveBeenCalledTimes(1);
  expect(childProcess.fork).toHaveBeenCalledWith(
    expect.any(String),
    [],
    expect.objectContaining({
      execArgv: ["--max-old-space-size=128"],
    }),
  );
  expect(child.kill).toHaveBeenCalledWith("SIGKILL");
});

test("stalled decoders time out and running/queued work can be cancelled", async () => {
  vi.useFakeTimers();
  const child = fakeChild();
  const stalled = processChatImage(
    input(syntheticPng(12, 9)),
    thumbnailOptions,
  );
  const timedOut = expect(stalled).rejects.toThrow("CHAT_IMAGE_TIMEOUT");
  await vi.advanceTimersByTimeAsync(15000);
  await timedOut;
  const controller = new AbortController();
  const active = processChatImage(
    input(syntheticPng(13, 9)),
    thumbnailOptions,
    controller.signal,
  );
  const cancelled = expect(active).rejects.toThrow("CHAT_IMAGE_CANCELLED");
  controller.abort();
  await cancelled;
  const first = new AbortController(),
    second = new AbortController(),
    queued = new AbortController();
  const tasks = [first, second, queued].map((abort, index) =>
    processChatImage(
      input(syntheticPng(20 + index, 9)),
      thumbnailOptions,
      abort.signal,
    ),
  );
  const rejections = tasks.map((task) =>
    expect(task).rejects.toThrow("CHAT_IMAGE_CANCELLED"),
  );
  expect(childProcess.fork).toHaveBeenCalledTimes(4);
  queued.abort();
  first.abort();
  second.abort();
  await Promise.all(rejections);
  expect(child.kill).toHaveBeenCalled();
});

test("processed-image cache evicts by retained bytes instead of growing with history", async () => {
  const child = fakeChild();
  const images = Array.from({ length: 5 }, (_, index) =>
    input(syntheticPng(40 + index, 10)),
  );
  const complete = async (image: (typeof images)[number]) => {
    const task = processChatImage(image, originalOptions);
    child.emit("message", {
      result: {
        data: "a".repeat(4 * 1024 * 1024),
        mimeType: "image/png",
        originalWidth: 40,
        originalHeight: 10,
        width: 40,
        height: 10,
      },
    });
    await task;
  };
  for (const image of images) await complete(image);
  expect(childProcess.fork).toHaveBeenCalledTimes(5);
  await processChatImage(images[4], originalOptions);
  expect(childProcess.fork).toHaveBeenCalledTimes(5);
  await complete(images[0]);
  expect(childProcess.fork).toHaveBeenCalledTimes(6);
});
