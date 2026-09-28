import { z } from "zod";
import { processChatImage, originalOptions } from "./image-processing";
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
    if (images.length > CHAT_IMAGE_LIMITS.count) return;
    let total = 0;
    for (const image of images) {
      // Zod can run refinements after a size issue. Do not allocate a decoded
      // buffer for a string already outside the accepted byte envelope.
      if (image.data.length > Math.ceil(CHAT_IMAGE_LIMITS.perImage / 3) * 4) {
        ctx.addIssue({ code: "custom", message: "CHAT_IMAGE_SIZE" });
        return;
      }
      const bytes = Buffer.from(image.data, "base64");
      total += bytes.length;
      if (total > CHAT_IMAGE_LIMITS.total) {
        ctx.addIssue({ code: "custom", message: "CHAT_IMAGE_TOTAL" });
        return;
      }
      if (
        bytes.toString("base64") !== image.data ||
        imageMimeType(bytes) !== image.mimeType ||
        !bytes.length
      )
        ctx.addIssue({ code: "custom", message: "CHAT_IMAGE_INVALID" });
      if (bytes.length > CHAT_IMAGE_LIMITS.perImage)
        ctx.addIssue({ code: "custom", message: "CHAT_IMAGE_SIZE" });
    }
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
  for (const image of images) {
    await processChatImage(image, originalOptions);
  }
}
