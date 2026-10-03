import {
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { ContextMenu } from "@base-ui/react/context-menu";
import { CopyIcon, DownloadIcon, Loader2Icon } from "lucide-react";
import { toast } from "@/components/ui/toast";
import {
  ContextMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { useCopyImage } from "@/hooks/use-copy-image";
import { useAppTranslation } from "@/i18n";
import { ChatImageContext } from "@/lib/chat-images";
import { downloadImagePart } from "@/lib/download-image";
import type { ImageLease } from "@/lib/image-loader";

export function ImageMenu({
  source,
  resolvedSource,
  filename,
  children,
}: {
  source?: string;
  resolvedSource?: string;
  filename?: string;
  children: ReactElement;
}) {
  const { t } = useAppTranslation();
  const { load } = useContext(ChatImageContext);
  const { copyImage, isCopying } = useCopyImage(source);
  const [downloading, setDownloading] = useState(false);
  const active = useRef<AbortController | undefined>(undefined);
  const trigger = useRef<HTMLDivElement | null>(null);
  const firstAction = useRef<HTMLDivElement | null>(null);
  const keyboardMenu = useRef(false);

  useEffect(() => {
    setDownloading(false);
    return () => {
      active.current?.abort();
      active.current = undefined;
    };
  }, [source, load]);

  const copy = async () => {
    const result = await copyImage(resolvedSource);
    if (!result) return;
    toast.add({
      type: result === "copied" ? "success" : "error",
      title: t(result === "copied" ? "image.copied" : "image.copyFailed"),
      timeout: result === "copied" ? 3200 : 0,
      priority: result === "copied" ? "low" : "high",
    });
  };

  const download = async () => {
    if (!source || active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setDownloading(true);
    let lease: ImageLease | undefined;
    try {
      // Hold an independent lease: closing the preview must not revoke a
      // download's URL before Chromium has consumed it.
      let url = source;
      if (source.startsWith("worklens-image:")) {
        lease = await load(source, "original", controller.signal);
        url = lease.url;
      }
      controller.signal.throwIfAborted();
      downloadImagePart({ image: url, filename });
      if (lease) {
        const retained = lease;
        setTimeout(() => retained.release(), 40_000);
        lease = undefined;
      }
    } catch {
      if (!controller.signal.aborted)
        toast.add({
          type: "error",
          title: t("image.downloadFailed"),
          timeout: 0,
          priority: "high",
        });
    } finally {
      lease?.release();
      if (active.current === controller) {
        active.current = undefined;
        setDownloading(false);
      }
    }
  };

  return (
    <ContextMenu.Root
      onOpenChangeComplete={(open) => {
        if (open && keyboardMenu.current) firstAction.current?.focus();
        if (!open) keyboardMenu.current = false;
      }}
    >
      <ContextMenu.Trigger
        ref={trigger}
        render={children}
        onKeyDown={(event) => {
          if (
            event.key === "ContextMenu" ||
            (event.shiftKey && event.key === "F10")
          ) {
            event.preventDefault();
            keyboardMenu.current = true;
            const box = event.currentTarget.getBoundingClientRect();
            event.currentTarget.dispatchEvent(
              new MouseEvent("contextmenu", {
                bubbles: true,
                clientX: box.left,
                clientY: box.bottom,
              }),
            );
          }
        }}
      />
      <ContextMenuContent className="w-max" finalFocus={trigger}>
        <DropdownMenuGroup>
          <DropdownMenuItem
            ref={firstAction}
            disabled={isCopying || !source}
            onClick={() => void copy()}
          >
            {isCopying ? (
              <Loader2Icon className="animate-spin" />
            ) : (
              <CopyIcon />
            )}
            {t(isCopying ? "image.copying" : "image.copy")}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={downloading || !source}
            onClick={() => void download()}
          >
            {downloading ? (
              <Loader2Icon className="animate-spin" />
            ) : (
              <DownloadIcon />
            )}
            {t(downloading ? "image.downloading" : "image.download")}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </ContextMenuContent>
    </ContextMenu.Root>
  );
}
