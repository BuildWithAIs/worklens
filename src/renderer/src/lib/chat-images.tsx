import { createContext, useContext, useEffect, useState } from "react";
import type {
  Attachment,
  AttachmentAdapter,
  PendingAttachment,
  AppendMessage,
} from "@assistant-ui/react";
import {
  CHAT_IMAGE_LIMITS,
  CHAT_IMAGE_TYPES,
  imageMimeType,
  base64ImageBytes,
  type ChatImage,
} from "../../../shared/chat-images";

export const ChatImageContext = createContext({
  supported: false,
  historical: false,
  load: async (_source: string): Promise<string> => {
    throw new Error("CHAT_IMAGE_MISSING");
  },
  reportError: (_message: string) => {},
});

export function createImageAdapter(
  getState: () => { supported: boolean; attachments: readonly Attachment[] },
): AttachmentAdapter {
  const pending = new Map<string, number>();
  return {
    accept: CHAT_IMAGE_TYPES.join(","),
    async *add({ file }) {
      const state = getState();
      if (!state.supported) throw new Error("CHAT_IMAGE_MODEL");
      if (!file.size || file.size > CHAT_IMAGE_LIMITS.perImage)
        throw new Error("CHAT_IMAGE_SIZE");
      const sizes = new Map(
        state.attachments.map((a) => [
          a.id,
          a.file?.size ??
            base64ImageBytes(
              a.content?.find((p) => p.type === "image")?.image.split(",")[1] ??
                "",
            ),
        ]),
      );
      for (const [id, size] of pending) sizes.set(id, size);
      if (sizes.size >= CHAT_IMAGE_LIMITS.count)
        throw new Error("CHAT_IMAGE_LIMITS");
      if (
        [...sizes.values()].reduce((sum, size) => sum + size, file.size) >
        CHAT_IMAGE_LIMITS.total
      )
        throw new Error("CHAT_IMAGE_TOTAL");
      const id = crypto.randomUUID();
      pending.set(id, file.size);
      const attachment: PendingAttachment = {
        id,
        type: "image",
        name: file.name.slice(0, 255) || "image",
        file,
        contentType: file.type,
        status: { type: "running", reason: "uploading", progress: 0 },
      };
      try {
        yield attachment;
        const bytes = new Uint8Array(await file.arrayBuffer());
        const mimeType = imageMimeType(bytes);
        if (!mimeType || mimeType !== file.type)
          throw new Error("CHAT_IMAGE_INVALID");
        const bitmap = await createImageBitmap(file).catch(() => {
          throw new Error("CHAT_IMAGE_INVALID");
        });
        const pixels = bitmap.width * bitmap.height;
        bitmap.close();
        if (pixels > CHAT_IMAGE_LIMITS.pixels)
          throw new Error("CHAT_IMAGE_DIMENSIONS");
        const source = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error("CHAT_IMAGE_INVALID"));
          reader.readAsDataURL(file);
        });
        yield {
          ...attachment,
          content: [{ type: "image", image: source }],
          status: { type: "requires-action", reason: "composer-send" },
        };
      } finally {
        pending.delete(id);
      }
    },
    async send(attachment) {
      if (attachment.status.type !== "requires-action" || !attachment.content)
        throw new Error("CHAT_IMAGE_INVALID");
      return {
        ...attachment,
        content: attachment.content,
        status: { type: "complete" },
      };
    },
    async remove(attachment) {
      pending.delete(attachment.id);
    },
  };
}

export function submittedImages(message: AppendMessage): ChatImage[] {
  const images = (message.attachments ?? []).flatMap((attachment) =>
    attachment.content.flatMap((part) => {
      if (part.type !== "image") return [];
      const match =
        /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+=*)$/.exec(
          part.image,
        );
      if (!match) throw new Error("CHAT_IMAGE_INVALID");
      return [
        {
          name: attachment.name,
          mimeType: match[1] as ChatImage["mimeType"],
          data: match[2],
        },
      ];
    }),
  );
  if (images.length > CHAT_IMAGE_LIMITS.count)
    throw new Error("CHAT_IMAGE_LIMITS");
  if (
    images.reduce((sum, image) => sum + base64ImageBytes(image.data), 0) >
    CHAT_IMAGE_LIMITS.total
  )
    throw new Error("CHAT_IMAGE_TOTAL");
  return images;
}

export function useStoredImage(source?: string) {
  const { load } = useContext(ChatImageContext);
  const [result, setResult] = useState<{
    source: string;
    url?: string;
    error?: boolean;
  }>();
  const [attempt, retry] = useState(0);
  useEffect(() => {
    if (!source?.startsWith("worklens-image:")) return;
    let cancelled = false;
    void load(source).then(
      (url) => {
        if (!cancelled) setResult({ source, url });
      },
      () => {
        if (!cancelled) setResult({ source, error: true });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [source, load, attempt]);
  return {
    src: source?.startsWith("worklens-image:")
      ? result?.source === source
        ? result.url
        : undefined
      : source,
    error: result?.source === source && result?.error,
    retry: () => retry((value) => value + 1),
  };
}
