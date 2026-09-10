"use client";

import { copyText } from "@/lib/clipboard";
import { toast } from "@/components/ui/toast";
import { useLocale } from "@/lib/locale";
import { useEffect, useRef, useState } from "react";

export type UseCopyToClipboardOptions = {
  copiedDuration?: number;
};

export const useCopyToClipboard = ({
  copiedDuration = 3000,
}: UseCopyToClipboardOptions = {}) => {
  const { t } = useLocale();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const [isCopied, setIsCopied] = useState<boolean>(false);

  const copyToClipboard = (value: string) => {
    if (!value || typeof navigator === "undefined") {
      return;
    }

    copyText(value).then(
      () => {
        setIsCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setIsCopied(false), copiedDuration);
      },
      () => {
        setIsCopied(false);
        toast.add({
          type: "error",
          title: t(
            "Could not copy. Select the text and copy it manually.",
            "复制失败，请选择文字后手动复制。",
          ),
        });
      },
    );
  };

  return { isCopied, copyToClipboard };
};
