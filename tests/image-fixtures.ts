import { crc32, deflateSync } from "node:zlib";
import { randomBytes } from "node:crypto";

export function pngChunk(type: string, data: Buffer) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const head = Buffer.alloc(4),
    tail = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
}

// Entirely synthetic pixels; never derived from screenshots or user files.
export function syntheticPng(width: number, height: number, noise = false) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  if (noise)
    for (let y = 0; y < height; y++)
      randomBytes(width * 3).copy(rows, y * (width * 3 + 1) + 1);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export function pngHeader(width: number, height: number) {
  const bytes = syntheticPng(1, 1);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes.writeUInt32BE(crc32(bytes.subarray(12, 29)), 29);
  return bytes;
}

// A one-pixel red frame, optionally followed by a blue frame. The LZW blocks
// contain only clear, palette index and end codes; no user image is involved.
export function syntheticGif(animated = false) {
  const header = Buffer.from([
    ...Buffer.from("GIF89a"),
    1,
    0,
    1,
    0,
    0x80,
    0,
    0,
    255,
    0,
    0,
    0,
    0,
    255,
  ]);
  const frame = (pixel: number) =>
    Buffer.from([
      0x21,
      0xf9,
      4,
      0,
      10,
      0,
      0,
      0,
      0x2c,
      0,
      0,
      0,
      0,
      1,
      0,
      1,
      0,
      0,
      2,
      2,
      pixel ? 0x4c : 0x44,
      1,
      0,
    ]);
  return Buffer.concat([
    header,
    frame(0),
    ...(animated ? [frame(1)] : []),
    Buffer.from([0x3b]),
  ]);
}
