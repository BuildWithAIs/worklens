import { z } from "zod";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import type { ChatImage } from "../shared/chat-images";
import {
  CHAT_IMAGE_LIMITS,
  CHAT_IMAGE_TYPES,
  imageMimeType,
} from "../shared/chat-images";

export const chatImagesSchema = z
  .array(
    z
      .object({
        name: z.string().min(1).max(255),
        mimeType: z.enum(CHAT_IMAGE_TYPES),
        data: z
          .string()
          .min(4)
          .max(Math.ceil(CHAT_IMAGE_LIMITS.perImage / 3) * 4),
      })
      .strict(),
  )
  .max(CHAT_IMAGE_LIMITS.count)
  .superRefine((images, ctx) => {
    let total = 0;
    for (const image of images) {
      const bytes = Buffer.from(image.data, "base64");
      total += bytes.length;
      if (
        bytes.toString("base64") !== image.data ||
        imageMimeType(bytes) !== image.mimeType ||
        !bytes.length
      )
        ctx.addIssue({ code: "custom", message: "CHAT_IMAGE_INVALID" });
      if (bytes.length > CHAT_IMAGE_LIMITS.perImage)
        ctx.addIssue({ code: "custom", message: "CHAT_IMAGE_SIZE" });
    }
    if (total > CHAT_IMAGE_LIMITS.total)
      ctx.addIssue({ code: "custom", message: "CHAT_IMAGE_TOTAL" });
  });

export function validateChatImages(images: unknown) {
  const parsed = chatImagesSchema.safeParse(images);
  if (!parsed.success) {
    const custom = parsed.error.issues.find((issue) => issue.code === "custom");
    throw new Error(custom?.message ?? "CHAT_IMAGE_LIMITS");
  }
  return parsed.data;
}

export async function validateImageContent(images: ChatImage[]) {
  // Pi's worker decoder supports all accepted formats. Keep the original bytes;
  // these options avoid resizing or re-encoding during validation.
  for (const image of images) {
    const decoded = await resizeImage(
      Buffer.from(image.data, "base64"),
      image.mimeType,
      {
        maxWidth: Number.MAX_SAFE_INTEGER,
        maxHeight: Number.MAX_SAFE_INTEGER,
        maxBytes: Math.ceil(CHAT_IMAGE_LIMITS.perImage / 3) * 4 + 1,
      },
    );
    if (!decoded) throw new Error("CHAT_IMAGE_INVALID");
    if (
      decoded.originalWidth * decoded.originalHeight >
      CHAT_IMAGE_LIMITS.pixels
    )
      throw new Error("CHAT_IMAGE_DIMENSIONS");
  }
}
