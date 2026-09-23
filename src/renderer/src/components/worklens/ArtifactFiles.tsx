import { useState } from "react";
import type { LocalArtifact } from "../../../../shared/contracts";
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
import { useAppTranslation } from "@/i18n";
export function ArtifactFiles({ result }: { result: unknown }) {
  const { t } = useAppTranslation();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const files =
    result &&
    typeof result === "object" &&
    "artifacts" in result &&
    Array.isArray(result.artifacts)
      ? (result.artifacts as LocalArtifact[])
      : [];
  if (!files.length) return null;
  async function act(id: string, action: "open" | "show" | "saveAs") {
    setBusy(true);
    setError("");
    try {
      await window.worklens.invoke("artifact", { id, action });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className="artifact-file-list flex flex-col gap-2"
      aria-label={t("artifacts.savedFiles")}
    >
      {files.map((file) => (
        <div
          key={file.id}
          data-slot="artifact-file-card"
          aria-busy={busy}
          className="html-artifact-card"
        >
          <div className="min-w-0 flex-1">
            <Hint
              content={<span className="link-target-hint">{file.path}</span>}
            >
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
              onClick={() => void act(file.id, "open")}
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
                    onClick={() => void act(file.id, "show")}
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
                    onClick={() => void act(file.id, "saveAs")}
                  >
                    <DownloadIcon />
                    {t("artifacts.saveAs")}
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        </div>
      ))}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
