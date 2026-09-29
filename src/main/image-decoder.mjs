// This entry runs only in a disposable, memory-limited child process. The
// pinned Pi 0.85.1 decoder is loaded directly: its public wrapper starts another
// worker and retries failed decoding in-process, defeating a per-process budget.
const { resizeImageInProcess } = await import(
  new URL(
    "./utils/image-resize-core.js",
    import.meta.resolve("@earendil-works/pi-coding-agent"),
  ).href
);

if (!process.connected) process.exit(0);

process.once("message", async ({ data, mimeType, options }) => {
  try {
    const result = await resizeImageInProcess(
      Buffer.from(data, "base64"),
      mimeType,
      options,
    );
    process.send?.({ result }, () => process.exit(0));
  } catch {
    process.send?.({ result: null }, () => process.exit(0));
  }
});
process.on("disconnect", () => process.exit(0));
