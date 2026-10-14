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
  type EditedChatImage,
  type PreparedChatImage,
  chatImageSource,
} from "../../../shared/chat-images";
import { imageDimensions } from "../../../shared/image-dimensions";
import type { ImageLease, ImageVariant } from "./image-loader";

export const draftImagePreviews = new WeakMap<File, string>();
export const draftImageSizes = new WeakMap<
  File,
  NonNullable<PreparedChatImage["resized"]>
>();
// Upper bound of a prepared image's decoded bytes.
const preparedBytes = Math.floor((CHAT_IMAGE_LIMITS.encodedImage * 3) / 4);

export const ChatImageContext = createContext({
  supported: false,
  historical: false,
  load: async (
    _source: string,
    _variant: ImageVariant,
    _signal: AbortSignal,
  ): Promise<ImageLease> => {
    throw new Error("CHAT_IMAGE_MISSING");
  },
  reportError: (_message: string) => {},
});

export function createImageAdapter(
  getState: () => {
    supported: boolean;
    disabled: boolean;
    attachments: readonly Attachment[];
  },
): AttachmentAdapter {
  const pending = new Set<string>();
  return {
    accept: CHAT_IMAGE_TYPES.join(","),
    async *add({ file }) {
      const state = getState();
      // File pickers and drop/paste callbacks can outlive the interaction that
      // opened them. Do not fill the draft reserved for a rejected submission.
      if (state.disabled) return;
      if (!state.supported) throw new Error("CHAT_IMAGE_MODEL");
      // Name the file: several may be added at once, and a rejected one has
      // no tile of its own.
      const fileName = encodeURIComponent(file.name.slice(0, 255) || "image");
      if (!file.size) throw new Error("CHAT_IMAGE_INVALID");
      if (file.size > CHAT_IMAGE_LIMITS.sourceBytes)
        throw new Error(`CHAT_IMAGE_SIZE ${fileName}`);
      // Images still being prepared count toward the image limit only. Their
      // stored size is known once main returns it, so the total is checked
      // again then, and once more when the message is sent.
      const storedBytes = (except?: string) =>
        getState().attachments.reduce((total, a) => {
          const image = a.content?.find((p) => p.type === "image")?.image;
          return a.id === except || !image
            ? total
            : total + base64ImageBytes(image.split(",")[1] ?? "");
        }, 0);
      const count = new Set([
        ...getState().attachments.map((a) => a.id),
        ...pending,
      ]).size;
      if (count >= CHAT_IMAGE_LIMITS.count)
        throw new Error("CHAT_IMAGE_LIMITS");
      if (
        storedBytes() + Math.min(file.size, preparedBytes) >
        CHAT_IMAGE_LIMITS.total
      )
        throw new Error("CHAT_IMAGE_TOTAL");
      const id = crypto.randomUUID();
      pending.add(id);
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
        // Report the size so the person does not need to look it up.
        const { width, height } = imageDimensions(bytes, Infinity);
        if (width * height > CHAT_IMAGE_LIMITS.sourcePixels)
          throw new Error(
            `CHAT_IMAGE_DIMENSIONS ${width}x${height} ${fileName}`,
          );
        const source = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error("CHAT_IMAGE_INVALID"));
          reader.readAsDataURL(file);
        });
        const prepared = await window.worklens.invoke("prepareChatImage", {
          image: {
            name: attachment.name,
            mimeType,
            data: source.slice(source.indexOf(",") + 1),
          },
        });
        const { image } = prepared;
        if (
          storedBytes(id) + base64ImageBytes(image.data) >
          CHAT_IMAGE_LIMITS.total
        )
          throw new Error("CHAT_IMAGE_TOTAL");
        draftImagePreviews.set(file, prepared.preview);
        if (prepared.resized) draftImageSizes.set(file, prepared.resized);
        yield {
          ...attachment,
          name: image.name,
          contentType: image.mimeType,
          content: [
            {
              type: "image",
              image: `data:${image.mimeType};base64,${image.data}`,
            },
          ],
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
  return imageAttachments(message.attachments ?? []);
}

function imageAttachments(attachments: readonly Attachment[]): ChatImage[] {
  const images = attachments.flatMap((attachment) =>
    (attachment.content ?? []).flatMap((part) => {
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

export function editedImages(
  attachments: readonly Attachment[],
  conversationId: string,
  original: import("../../../shared/contracts").MessageView,
): EditedChatImage[] {
  return attachments.flatMap((attachment): EditedChatImage[] => {
    const source = attachment.content?.find(
      (part) => part.type === "image",
    )?.image;
    if (source?.startsWith("worklens-image:")) {
      const image = original.images?.find(
        (image) => chatImageSource(conversationId, image) === source,
      );
      if (!image) throw new Error("CHAT_IMAGE_MISSING");
      return [{ existingIndex: image.index }];
    }
    return imageAttachments([attachment]);
  });
}

export function useStoredImage(
  source?: string,
  enabled = true,
  variant: ImageVariant = "thumbnail",
) {
  const { load } = useContext(ChatImageContext);
  const [result, setResult] = useState<{
    source: string;
    variant: ImageVariant;
    url?: string;
    error?: boolean;
  }>();
  const [attempt, retry] = useState(0);
  useEffect(() => {
    if (!enabled || !source?.startsWith("worklens-image:")) return;
    const controller = new AbortController();
    let lease: ImageLease | undefined;
    setResult(undefined);
    void load(source, variant, controller.signal).then(
      (value) => {
        if (controller.signal.aborted) value.release();
        else {
          lease = value;
          setResult({ source, variant, url: value.url });
        }
      },
      () => {
        if (!controller.signal.aborted)
          setResult({ source, variant, error: true });
      },
    );
    return () => {
      controller.abort();
      lease?.release();
    };
  }, [source, load, attempt, enabled, variant]);
  return {
    src: !enabled
      ? undefined
      : source?.startsWith("worklens-image:")
        ? result?.source === source && result.variant === variant
          ? result.url
          : undefined
        : source,
    error:
      enabled &&
      result?.source === source &&
      result?.variant === variant &&
      result?.error,
    retry: () => retry((value) => value + 1),
  };
}
