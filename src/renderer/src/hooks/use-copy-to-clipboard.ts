"use client";

import { copyText } from "@/lib/clipboard";
import { toast } from "@/components/ui/toast";
import { useAppTranslation } from "@/i18n";
import { useEffect, useRef, useState } from "react";

export type UseCopyToClipboardOptions = {
  copiedDuration?: number;
  successMessage?: string;
};

export const useCopyToClipboard = ({
  copiedDuration = 3000,
  successMessage,
}: UseCopyToClipboardOptions = {}) => {
  const { t } = useAppTranslation();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const [isCopied, setIsCopied] = useState<boolean>(false);

  const copyToClipboard = (value: string) => {
    if (!value || typeof navigator === "undefined") {
      return;
    }

    copyText(value).then(
      () => {
        if (successMessage)
          toast.add({ type: "success", title: successMessage });
        setIsCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setIsCopied(false), copiedDuration);
      },
      () => {
        setIsCopied(false);
        toast.add({
          type: "error",
          title: t("clipboard.error"),
        });
      },
    );
  };

  return { isCopied, copyToClipboard };
};
