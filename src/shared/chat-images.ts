export const CHAT_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;
// Per-message limits stay below common provider limits: 20 images per message
// (ChatGPT, Claude.ai, Bedrock) and 48-50 MiB request bodies (DeepSeek, older
// OpenAI). Images are resized again to fit each provider's request budget.
export const CHAT_IMAGE_LIMITS = {
  count: 15,
  perImage: 5 * 1024 * 1024,
  total: 40 * 1024 * 1024,
  pixels: 25_000_000,
  // Larger sources are accepted when attached and reduced to fit the edge and
  // encoded-size budget below before they enter a draft.
  sourceBytes: 20 * 1024 * 1024,
  sourcePixels: 100_000_000,
  edge: 2000,
  encodedImage: 4_500_000,
} as const;

export interface ChatImage {
  name: string;
  mimeType: (typeof CHAT_IMAGE_TYPES)[number];
  data: string;
}

export interface PreparedChatImage {
  image: ChatImage;
  preview: string;
  // Present only when the stored image is smaller than the source.
  resized?: { width: number; height: number };
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
