import { useContext, useEffect, useRef, useState } from "react";
import { ChatImageContext } from "@/lib/chat-images";
import { copyImage as writeImage } from "@/lib/clipboard";
import type { ImageLease } from "@/lib/image-loader";

export function useCopyImage(source?: string) {
  const { load } = useContext(ChatImageContext);
  const active = useRef<AbortController | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [isCopying, setIsCopying] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    setIsCopying(false);
    setIsCopied(false);
    setError(false);
    return () => {
      active.current?.abort();
      active.current = undefined;
      clearTimeout(timer.current);
    };
  }, [source, load]);

  const copyImage = async (resolvedSource?: string) => {
    if (!source || active.current) return;
    const controller = new AbortController();
    active.current = controller;
    clearTimeout(timer.current);
    setIsCopying(true);
    setIsCopied(false);
    setError(false);
    let lease: ImageLease | undefined;
    try {
      let url = resolvedSource ?? source;
      if (url.startsWith("worklens-image:")) {
        lease = await load(url, "original", controller.signal);
        url = lease.url;
      }
      await writeImage(url, controller.signal);
      if (!controller.signal.aborted) {
        setIsCopied(true);
        timer.current = setTimeout(() => setIsCopied(false), 3000);
        return "copied" as const;
      }
    } catch {
      if (!controller.signal.aborted) {
        setError(true);
        return "failed" as const;
      }
    } finally {
      lease?.release();
      if (active.current === controller) {
        active.current = undefined;
        setIsCopying(false);
      }
    }
  };
  return { copyImage, isCopying, isCopied, error };
}
