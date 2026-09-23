import { useEffect, useRef, useState, type ReactNode } from "react";
import { CopyIcon, FolderSearch, MoreHorizontalIcon } from "lucide-react";
import type { ConversationFile, Requests } from "../../../../shared/contracts";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { Hint } from "@/components/ui/tooltip";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
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
  children,
}: {
  path: string;
  label?: string;
  children?: ReactNode;
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
      <span className="local-file-reference" data-slot="local-file-reference">
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
        {children}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <TooltipIconButton
                tooltip={t("localFiles.actions")}
                aria-label={
                  t("localFiles.actions") +
                  ": " +
                  (displayLabel || fileName(file?.path ?? path))
                }
                className="local-file-menu"
              />
            }
          >
            <MoreHorizontalIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-max min-w-45">
            <DropdownMenuGroup>
              <DropdownMenuItem
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
              <DropdownMenuItem onClick={() => void copyPath()}>
                <CopyIcon />
                {t("localFiles.copyPath")}
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
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
