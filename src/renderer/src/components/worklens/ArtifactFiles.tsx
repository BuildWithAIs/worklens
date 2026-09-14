import { useState } from "react";
import type { LocalArtifact } from "../../../../shared/contracts";
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
      className="my-2 flex flex-col gap-2"
      aria-label={t("artifacts.savedFiles")}
    >
      {files.map((file) => (
        <div
          key={file.id}
          className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm"
        >
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium" title={file.path}>
              {file.name}
            </p>
            <p className="text-xs text-muted-foreground">
              {(file.size / 1024).toFixed(1)} KB
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void act(file.id, "open")}
          >
            {t("common.open")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void act(file.id, "show")}
          >
            {t("artifacts.showInFolder")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void act(file.id, "saveAs")}
          >
            {t("artifacts.saveAs")}
          </Button>
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
