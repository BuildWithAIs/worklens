import sharp from "sharp";

// Native allocations are not bounded by V8's heap limit. Keep decoding in a
// disposable process, limit input pixels, and avoid libvips caches/thread pools.
sharp.cache(false);
sharp.concurrency(1);

if (!process.connected) process.exit(0);

process.once("message", async ({ data, mimeType, options, pixelLimit }) => {
  try {
    const bytes = Buffer.from(data, "base64");
    const source = sharp(bytes, {
      limitInputPixels: pixelLimit,
      failOn: "warning",
    });
    const metadata = await source.metadata();
    const swapped = (metadata.orientation ?? 1) >= 5;
    const originalWidth = swapped ? metadata.height : metadata.width;
    const originalHeight = swapped ? metadata.width : metadata.height;
    const scale = Math.min(
      1,
      options.maxWidth / originalWidth,
      options.maxHeight / originalHeight,
    );
    const fits = (buffer) =>
      Math.ceil(buffer.length / 3) * 4 < options.maxBytes;
    let result;
    if (
      scale === 1 &&
      fits(bytes) &&
      (options.preserveOriginal || (metadata.orientation ?? 1) === 1)
    ) {
      // Metadata alone does not detect truncated pixel data. Decode before
      // returning untouched bytes for history/original previews or small inputs.
      await source.stats();
      result = {
        data,
        mimeType,
        originalWidth,
        originalHeight,
        width: originalWidth,
        height: originalHeight,
      };
    } else {
      let width = Math.max(1, Math.round(originalWidth * scale));
      let height = Math.max(1, Math.round(originalHeight * scale));
      for (let attempt = 0; attempt < 16 && !result; attempt++) {
        const resized = source
          .clone()
          .autoOrient()
          .resize({
            width,
            height,
            fit: "inside",
            withoutEnlargement: true,
            fastShrinkOnLoad: false,
          });
        const formats = metadata.hasAlpha
          ? ["png"]
          : mimeType === "image/jpeg"
            ? [85, 70, 55]
            : ["png", 85, 70, 55];
        let lastBytes = 0;
        for (const format of formats) {
          const encoded = await (
            format === "png"
              ? resized.clone().png()
              : resized
                  .clone()
                  .jpeg({ quality: format, chromaSubsampling: "4:4:4" })
          ).toBuffer({ resolveWithObject: true });
          lastBytes = encoded.data.length;
          if (fits(encoded.data)) {
            result = {
              data: encoded.data.toString("base64"),
              mimeType: `image/${encoded.info.format}`,
              originalWidth,
              originalHeight,
              width: encoded.info.width,
              height: encoded.info.height,
            };
            break;
          }
        }
        if (!result) {
          if (width === 1 && height === 1) break;
          const reduction = Math.min(
            0.75,
            Math.sqrt((options.maxBytes * 0.7) / ((lastBytes * 4) / 3)),
          );
          width = Math.max(1, Math.floor(width * reduction));
          height = Math.max(1, Math.floor(height * reduction));
        }
      }
    }
    process.send?.(result ? { result } : { error: "CHAT_IMAGE_REQUEST" }, () =>
      process.exit(0),
    );
  } catch (error) {
    const message = String(error);
    const code = /pixel limit/i.test(message)
      ? "CHAT_IMAGE_DIMENSIONS"
      : /corrupt|truncat|invalid|unsupported image|premature|pngload|jpegload|webpload|VipsJpeg|VipsPng|VipsWebp/i.test(
            message,
          )
        ? "CHAT_IMAGE_INVALID"
        : "CHAT_IMAGE_PROCESSING";
    process.send?.({ error: code }, () => process.exit(0));
  }
});
process.on("disconnect", () => process.exit(0));
