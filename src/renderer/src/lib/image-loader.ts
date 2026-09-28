export type ImageVariant = "thumbnail" | "original";
export interface ImageLease {
  url: string;
  release: () => void;
}

// Only two IPC reads at a time. Queued reads that have left the viewport are
// skipped. No session-wide data URL cache: each mounted preview owns a Blob URL
// and releases it on scroll-out, dialog close, conversation switch or unmount.
export function createImageLoader(conversationId?: string) {
  let running = 0;
  const queue: { resume: () => void }[] = [];
  return async (
    source: string,
    variant: ImageVariant,
    signal: AbortSignal,
  ): Promise<ImageLease> => {
    const match = /^worklens-image:([\w-]+)\/([\w-]+)\/(\d+)$/.exec(source);
    if (!match || match[1] !== conversationId)
      throw new Error("CHAT_IMAGE_MISSING");
    signal.throwIfAborted();
    if (running >= 2)
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          const index = queue.indexOf(entry);
          if (index !== -1) queue.splice(index, 1);
          reject(signal.reason);
        };
        const entry = {
          resume: () => {
            signal.removeEventListener("abort", abort);
            resolve();
          },
        };
        queue.push(entry);
        signal.addEventListener("abort", abort, { once: true });
      });
    else running++;
    try {
      signal.throwIfAborted();
      const data = await window.worklens.invoke("chatImage", {
        conversationId: match[1],
        messageId: match[2],
        index: Number(match[3]),
        variant,
      });
      signal.throwIfAborted();
      const comma = data.indexOf(",");
      const mime = /^data:(image\/(?:png|jpeg|webp));base64$/.exec(
        data.slice(0, comma),
      )?.[1];
      if (!mime) throw new Error("CHAT_IMAGE_INVALID");
      const raw = atob(data.slice(comma + 1));
      const bytes = Uint8Array.from(raw, (character) =>
        character.charCodeAt(0),
      );
      const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
      return { url, release: () => URL.revokeObjectURL(url) };
    } finally {
      const next = queue.shift();
      if (next) next.resume();
      else running--;
    }
  };
}
