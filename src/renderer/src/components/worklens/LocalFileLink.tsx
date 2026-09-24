import { useEffect, useRef, useState } from "react";
import { CopyIcon, FolderSearch } from "lucide-react";
import type { ConversationFile, Requests } from "../../../../shared/contracts";
import {
  ContextMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { ContextMenu } from "@base-ui/react/context-menu";
import { Hint } from "@/components/ui/tooltip";

import { fileName } from "@/lib/link-label";
import { ImageZoom } from "@/components/assistant-ui/elements/image";
import { toast } from "@/components/ui/toast";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useAppTranslation } from "@/i18n";
import { useArtifactWorkspace } from "./HtmlArtifact";

type Action = Requests["conversationFile"]["input"]["action"];

export function LocalFileLink({
  path,
  label: displayLabel,
}: {
  path: string;
  label?: string;
}) {
  const context = useArtifactWorkspace();
  const id = context?.conversationId;
  const { t } = useAppTranslation();
  const { copyToClipboard } = useCopyToClipboard({
    successMessage: t("localFiles.pathCopied"),
  });
  const [file, setFile] = useState<ConversationFile>();
  const [image, setImage] = useState<ConversationFile>();
  const [busy, setBusy] = useState(false);
  const anchor = useRef<HTMLAnchorElement>(null);
  const firstAction = useRef<HTMLDivElement>(null);
  const keyboardMenu = useRef(false);
  const generation = useRef(0);
  const acting = useRef(false);
  useEffect(() => {
    const current = ++generation.current;
    setFile(undefined);
    setImage(undefined);
    setBusy(false);
    acting.current = false;
    if (id)
      void window.worklens
        .invoke("conversationFile", { id, path, action: "inspect" })
        .then((value) => {
          if (current === generation.current) setFile(value);
        })
        .catch(() => {
          /* Retry on interaction, without noisy render-time toasts. */
        });
    return () => {
      generation.current++;
    };
  }, [id, path]);

  const unavailable = file?.issue && file.issue !== "tooLarge";
  const showError = (issue: ConversationFile["issue"] = "unavailable") => {
    toast.add({ type: "error", title: t(`localFiles.${issue}`) });
  };
  const copyPath = async () => {
    if (!id) return;
    const current = generation.current;
    try {
      const value =
        file ??
        (await window.worklens.invoke("conversationFile", {
          id,
          path,
          action: "inspect",
        }));
      if (!value) throw new Error("Unavailable file");
      if (current === generation.current) copyToClipboard(value.path);
    } catch {
      if (current === generation.current) showError();
    }
  };
  const perform = async (action: Action) => {
    if (!id || acting.current) return;
    const current = generation.current;
    acting.current = true;
    setBusy(true);
    try {
      let value = await window.worklens.invoke("conversationFile", {
        id,
        path,
        action,
      });
      if (current !== generation.current) return;
      if (!value) throw new Error("Unavailable file");
      setFile({ path: value.path, kind: value.kind, issue: value.issue });
      if (value.issue) {
        showError(value.issue);
        return;
      }
      if (action !== "preview") return;
      if (!["image", "html"].includes(value.kind)) {
        value = await window.worklens.invoke("conversationFile", {
          id,
          path,
          action: "open",
        });
        if (current === generation.current && value.issue)
          showError(value.issue);
      } else if (value.kind === "image" && value.content) {
        // Decode before displaying so corrupt images produce useful feedback.
        const probe = new window.Image();
        probe.src = value.content;
        await probe.decode();
        if (current === generation.current) setImage(value);
      } else if (
        value.kind === "html" &&
        value.content !== undefined &&
        anchor.current
      ) {
        context?.open({
          path,
          code: value.content,
          title: value.path.split(/[\\/]/).pop()!,
          filename: value.path.split(/[\\/]/).pop()!,
          trigger: anchor.current,
          manual: true,
        });
      }
    } catch {
      if (current === generation.current) showError();
    } finally {
      if (current === generation.current) {
        acting.current = false;
        setBusy(false);
      }
    }
  };

  return (
    <>
      <ContextMenu.Root
        onOpenChangeComplete={(open) => {
          if (open && keyboardMenu.current) firstAction.current?.focus();
          if (!open) keyboardMenu.current = false;
        }}
      >
        <ContextMenu.Trigger
          render={
            <span
              className="local-file-reference"
              data-slot="local-file-reference"
            />
          }
        >
          <Hint
            content={
              <span className="link-target-hint">{file?.path ?? path}</span>
            }
          >
            <a
              ref={anchor}
              href="#"
              data-slot="local-file-link"
              className="aui-md-a local-file-link text-primary hover:text-primary/80 underline underline-offset-2"
              aria-busy={busy}
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
              onClick={(event) => {
                event.preventDefault();
                const selection = window.getSelection();
                if (
                  event.detail > 0 &&
                  selection &&
                  !selection.isCollapsed &&
                  selection.containsNode(event.currentTarget, true)
                )
                  return;
                void perform("preview");
              }}
            >
              {displayLabel || fileName(file?.path ?? path)}
            </a>
          </Hint>
        </ContextMenu.Trigger>
        <ContextMenuContent className="w-max min-w-45" finalFocus={anchor}>
          <DropdownMenuGroup>
            <DropdownMenuItem
              ref={unavailable ? undefined : firstAction}
              onClick={() => void perform("reveal")}
              disabled={busy || !!unavailable}
            >
              <FolderSearch />
              {t(
                navigator.platform.startsWith("Mac")
                  ? "htmlArtifact.showInFinder"
                  : "htmlArtifact.showInFolder",
              )}
            </DropdownMenuItem>
            <DropdownMenuItem
              ref={unavailable ? firstAction : undefined}
              onClick={() => void copyPath()}
            >
              <CopyIcon />
              {t("localFiles.copyPath")}
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </ContextMenuContent>
      </ContextMenu.Root>
      {image?.content && (
        <ImageZoom
          src={image.content}
          alt={image.path}
          filename={image.path}
          open
          onOpenChange={(open) => {
            if (!open) setImage(undefined);
          }}
          returnFocus={anchor.current}
        />
      )}
    </>
  );
}
