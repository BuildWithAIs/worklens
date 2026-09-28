import { CHAT_IMAGE_LIMITS, imageMimeType } from "./chat-images";

// Read bounded headers before invoking any image decoder. Check every WebP
// frame header as well as the extended canvas so a small VP8X cannot hide a
// larger frame. Animated files are not accepted by the chat image pipeline.
export function imageDimensions(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const invalid = () => {
    throw new Error("CHAT_IMAGE_INVALID");
  };
  const dimensions = (width: number, height: number) => {
    if (!width || !height) return invalid();
    if (width * height > CHAT_IMAGE_LIMITS.pixels)
      throw new Error("CHAT_IMAGE_DIMENSIONS");
    return { width, height };
  };
  const label = (offset: number) =>
    String.fromCharCode(...bytes.subarray(offset, offset + 4));
  switch (imageMimeType(bytes)) {
    case "image/png": {
      if (bytes.length < 33 || label(12) !== "IHDR" || view.getUint32(8) !== 13)
        return invalid();
      const result = dimensions(view.getUint32(16), view.getUint32(20));
      for (let offset = 8; offset + 12 <= bytes.length; ) {
        const size = view.getUint32(offset);
        if (offset + size + 12 > bytes.length) return invalid();
        if (label(offset + 4) === "acTL") return invalid();
        offset += size + 12;
      }
      return result;
    }
    case "image/jpeg": {
      let result: { width: number; height: number } | undefined;
      for (let offset = 2; offset < bytes.length; ) {
        if (bytes[offset++] !== 0xff) return invalid();
        while (bytes[offset] === 0xff) offset++;
        const marker = bytes[offset++];
        if (marker === 0xda || marker === 0xd9) break;
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        if (offset + 2 > bytes.length) return invalid();
        const size = view.getUint16(offset);
        if (size < 2 || offset + size > bytes.length) return invalid();
        if (
          [
            0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd,
            0xce, 0xcf,
          ].includes(marker)
        ) {
          if (size < 8 || result) return invalid();
          result = dimensions(
            view.getUint16(offset + 5),
            view.getUint16(offset + 3),
          );
        }
        offset += size;
      }
      return result ?? invalid();
    }
    case "image/webp": {
      if (bytes.length < 20 || view.getUint32(4, true) + 8 !== bytes.length)
        return invalid();
      let canvas: { width: number; height: number } | undefined;
      let frame: { width: number; height: number } | undefined;
      const uint24 = (offset: number) =>
        bytes[offset] + bytes[offset + 1] * 256 + bytes[offset + 2] * 65536;
      for (let offset = 12; offset + 8 <= bytes.length; ) {
        const tag = label(offset),
          size = view.getUint32(offset + 4, true),
          start = offset + 8;
        if (start + size > bytes.length) return invalid();
        if (tag === "ANIM" || tag === "ANMF") return invalid();
        if (tag === "VP8X") {
          if (size !== 10 || canvas || bytes[start] & 2) return invalid();
          canvas = dimensions(uint24(start + 4) + 1, uint24(start + 7) + 1);
        } else if (tag === "VP8 " || tag === "VP8L") {
          if (frame) return invalid();
          if (tag === "VP8 ") {
            if (
              size < 10 ||
              bytes[start + 3] !== 0x9d ||
              bytes[start + 4] !== 1 ||
              bytes[start + 5] !== 0x2a
            )
              return invalid();
            frame = dimensions(
              view.getUint16(start + 6, true) & 0x3fff,
              view.getUint16(start + 8, true) & 0x3fff,
            );
          } else {
            if (size < 5 || bytes[start] !== 0x2f) return invalid();
            const bits = view.getUint32(start + 1, true);
            frame = dimensions(
              (bits & 0x3fff) + 1,
              ((bits >>> 14) & 0x3fff) + 1,
            );
          }
        }
        offset = start + size + (size & 1);
      }
      if (
        !frame ||
        (canvas &&
          (canvas.width !== frame.width || canvas.height !== frame.height))
      )
        return invalid();
      return frame;
    }
    default:
      return invalid();
  }
}
