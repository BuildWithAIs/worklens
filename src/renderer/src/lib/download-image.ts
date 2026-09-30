import type { ImageMessagePart } from "@assistant-ui/react";

const extensionForMimeType = (mimeType?: string): string => {
  switch (mimeType) {
    case "image/png":
      return "png";
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/svg+xml":
      return "svg";
    default:
      return "png";
  }
};

const dataUriToBlob = (dataUri: string): Blob => {
  const commaIndex = dataUri.indexOf(",");
  const meta = commaIndex >= 0 ? dataUri.slice(0, commaIndex) : dataUri;
  const data = commaIndex >= 0 ? dataUri.slice(commaIndex + 1) : "";
  const mime =
    meta.match(/data:([^;]+)/i)?.[1]?.toLowerCase() ??
    "application/octet-stream";
  if (!/;base64/i.test(meta)) {
    const text = data.replace(/(?:%[0-9A-Fa-f]{2})+/g, (seq) => {
      try {
        return decodeURIComponent(seq);
      } catch {
        return seq;
      }
    });
    return new Blob([text], { type: mime });
  }
  const bytes = atob(data);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime });
};

const mimeFromImage = (image: string): string | undefined =>
  image.match(/^data:([^;,]+)/i)?.[1]?.toLowerCase();

export const downloadImagePart = (
  part: Pick<ImageMessagePart, "image" | "filename">,
): void => {
  if (typeof document === "undefined") return;
  const ext = extensionForMimeType(mimeFromImage(part.image));
  const filename = part.filename ?? `image.${ext}`;
  const isDataUri = /^data:/i.test(part.image);
  const objectUrl = isDataUri
    ? URL.createObjectURL(dataUriToBlob(part.image))
    : null;
  const href = objectUrl ?? part.image;
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 40_000);
};
