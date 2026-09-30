// Copy only in response to a user action through the browser clipboard API.
export async function copyImage(source: string, signal: AbortSignal) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined")
    throw new Error("Image clipboard unavailable");
  const image = new Image();
  const canvas = document.createElement("canvas");
  const abort = () => image.removeAttribute("src");
  signal.throwIfAborted();
  signal.addEventListener("abort", abort, { once: true });
  try {
    // Use the image loading path allowed by the renderer's CSP, not fetch.
    // PNG is the portable clipboard format for all supported image types.
    image.src = source;
    await image.decode();
    signal.throwIfAborted();
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image conversion unavailable");
    context.drawImage(image, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (result) =>
          result
            ? resolve(result)
            : reject(new Error("Image conversion failed")),
        "image/png",
      ),
    );
    signal.throwIfAborted();
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  } finally {
    signal.removeEventListener("abort", abort);
    image.removeAttribute("src");
    canvas.width = canvas.height = 0;
  }
}

export async function copyText(text: string) {
  try {
    if (!navigator.clipboard) throw new Error("Clipboard unavailable");
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // Some desktop webviews reject the asynchronous Clipboard API.
    const active = document.activeElement as HTMLElement | null;
    const selection = document.getSelection();
    const ranges = selection
      ? Array.from({ length: selection.rangeCount }, (_, i) =>
          selection.getRangeAt(i).cloneRange(),
        )
      : [];
    const field = document.createElement("textarea");
    field.value = text;
    field.readOnly = true;
    field.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
    document.body.append(field);
    try {
      field.select();
      if (!document.execCommand("copy")) throw new Error("Copy failed");
    } finally {
      field.remove();
      active?.focus({ preventScroll: true });
      selection?.removeAllRanges();
      ranges.forEach((range) => selection?.addRange(range));
    }
  }
}
