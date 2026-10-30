import { useEffect, useRef, useState } from "react";
import type { LocalArtifact, Requests } from "../../../../shared/contracts";
import { isLocalReference } from "../../../../shared/file-references";
import { ChevronDownIcon, FolderSearch, DownloadIcon } from "lucide-react";
import { Hint } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { useAppTranslation } from "@/i18n";
import { useArtifactWorkspace } from "./HtmlArtifact";
import { isWebUrl, WebLink } from "./WebLink";
import { markdownReplyClassName } from "@/lib/markdown-presentation";

type Action = "open" | "show" | "saveAs";
function isArtifact(value: unknown): value is LocalArtifact {
  if (!value || typeof value !== "object") return false;
  const file = value as Partial<LocalArtifact>;
  return (
    typeof file.id === "string" &&
    typeof file.name === "string" &&
    typeof file.path === "string" &&
    typeof file.size === "number" &&
    Number.isFinite(file.size) &&
    file.size >= 0
  );
}

async function inspectArtifact(id: string) {
  const result = await window.worklens.invoke("artifact", {
    id,
    action: "inspect",
  });
  if (
    !isArtifact(result?.file) ||
    result.file.id !== id ||
    !isLocalReference(result.file.path)
  )
    throw new Error("Local artifact unavailable");
  return result.file;
}

export function ArtifactFiles({ result }: { result: unknown }) {
  const { t } = useAppTranslation();
  const workspace = useArtifactWorkspace();
  const [busy, setBusy] = useState(false);
  const acting = useRef(false);
  const files =
    result &&
    typeof result === "object" &&
    "artifacts" in result &&
    Array.isArray(result.artifacts)
      ? result.artifacts.filter(isArtifact)
      : [];
  if (!files.length) return null;
  async function act(id: string, action: Action) {
    if (acting.current) return;
    acting.current = true;
    setBusy(true);
    try {
      return await window.worklens.invoke("artifact", { id, action });
    } finally {
      acting.current = false;
      setBusy(false);
    }
  }
  return (
    <div
      className="artifact-file-list flex flex-col gap-2"
      aria-label={t("artifacts.files")}
    >
      {files.map((file) =>
        isWebUrl(file.path) ? (
          <div
            key={file.id + file.path}
            data-slot="artifact-remote-reference"
            className={markdownReplyClassName}
          >
            <WebLink href={file.path}>{file.name}</WebLink>
          </div>
        ) : (
          <ArtifactFile
            key={`${workspace?.conversationId}:${file.id}:${file.path}`}
            reference={file}
            busy={busy}
            act={act}
          />
        ),
      )}
    </div>
  );
}

function ArtifactFile({
  reference,
  busy,
  act,
}: {
  reference: LocalArtifact;
  busy: boolean;
  act: (id: string, action: Action) => Promise<Requests["artifact"]["output"]>;
}) {
  const { t } = useAppTranslation();
  const [file, setFile] = useState<LocalArtifact | null>();
  const [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    void inspectArtifact(reference.id).then(
      (value) => {
        if (current === generation.current) setFile(value);
      },
      () => {
        if (current === generation.current) setFile(null);
      },
    );
    return () => {
      generation.current++;
    };
  }, [reference.id]);

  async function perform(action: Action) {
    const current = generation.current;
    setError("");
    try {
      const result = await act(reference.id, action);
      if (current === generation.current && result?.revealed)
        toast.add({
          type: "warning",
          title: t("localFiles.executableRevealed"),
        });
    } catch (e) {
      if (current !== generation.current) return;
      setError(String(e));
      // A file can disappear after rendering. Recheck without treating an OS
      // application-opening failure as proof that the file itself disappeared.
      try {
        const value = await inspectArtifact(reference.id);
        if (current === generation.current) setFile(value);
      } catch {
        if (current === generation.current) setFile(null);
      }
    }
  }

  if (!file)
    return (
      <div
        data-slot="artifact-file-status"
        aria-busy={file === undefined}
        className="flex min-w-0 flex-col gap-1"
      >
        <p className="truncate font-medium">{reference.name}</p>
        <p role="status" className="text-xs text-muted-foreground">
          {t(
            file === undefined
              ? "artifacts.checkingFile"
              : "artifacts.localFileUnavailable",
          )}
        </p>
      </div>
    );
  return (
    <>
      <div
        data-slot="artifact-file-card"
        aria-busy={busy}
        className="html-artifact-card"
      >
        <div className="min-w-0 flex-1">
          <Hint content={<span className="link-target-hint">{file.path}</span>}>
            <p className="truncate font-medium" tabIndex={0}>
              {file.name}
            </p>
          </Hint>
          <p className="text-xs text-muted-foreground">
            {(file.size / 1024).toFixed(1)} KB
          </p>
        </div>
        <span className="artifact-split-button">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void perform("open")}
          >
            {t("common.open")}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={busy}
              render={
                <Button
                  size="sm"
                  variant="outline"
                  className="artifact-menu-trigger"
                  aria-label={t("localFiles.actions") + ": " + file.name}
                />
              }
            >
              <ChevronDownIcon className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-56">
              <DropdownMenuGroup>
                <DropdownMenuItem
                  disabled={busy}
                  onClick={() => void perform("show")}
                >
                  <FolderSearch />
                  {t(
                    navigator.platform.startsWith("Mac")
                      ? "htmlArtifact.showInFinder"
                      : "artifacts.showInFolder",
                  )}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={busy}
                  onClick={() => void perform("saveAs")}
                >
                  <DownloadIcon />
                  {t("artifacts.saveAs")}
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </>
  );
}
