"use client";

import { useAuiState } from "@assistant-ui/react";
import { useShallow } from "zustand/react/shallow";
import { draftImagePreviews, useStoredImage } from "@/lib/chat-images";
import type { ImageVariant } from "@/lib/image-loader";

export const useAttachmentSrc = (
  enabled = true,
  variant: ImageVariant = "thumbnail",
) => {
  const { file, src } = useAuiState(
    useShallow((s): { file?: File; src?: string } => {
      if (s.attachment.type !== "image") return {};
      const src = s.attachment.content?.filter((c) => c.type === "image")[0]
        ?.image;
      if (!src) return {};
      return { src, file: s.attachment.file };
    }),
  );

  const preview =
    variant === "thumbnail" && file ? draftImagePreviews.get(file) : undefined;
  return useStoredImage(preview ?? src, enabled, variant);
};
