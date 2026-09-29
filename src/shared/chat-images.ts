export const CHAT_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;
export const CHAT_IMAGE_LIMITS = {
  count: 8,
  perImage: 5 * 1024 * 1024,
  total: 20 * 1024 * 1024,
  pixels: 25_000_000,
} as const;

export interface ChatImage {
  name: string;
  mimeType: (typeof CHAT_IMAGE_TYPES)[number];
  data: string;
}

export type EditedChatImage = ChatImage | { existingIndex: number };

export interface ChatImageRef {
  messageId: string;
  index: number;
  name: string;
  mimeType: string;
}

export function base64ImageBytes(data: string) {
  return (
    Math.floor((data.length * 3) / 4) -
    (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0)
  );
}

// Only application-owned references are resolved through IPC, never file paths.
export function chatImageSource(conversationId: string, image: ChatImageRef) {
  return `worklens-image:${conversationId}/${image.messageId}/${image.index}`;
}

export function imageMimeType(
  bytes: Uint8Array,
): ChatImage["mimeType"] | undefined {
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b))
    return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return "image/jpeg";
  if (
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  )
    return "image/webp";
  return undefined;
}
