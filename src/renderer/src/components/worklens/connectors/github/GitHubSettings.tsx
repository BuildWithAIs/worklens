import { useState } from "react";
import type {
  GitHubConnection,
  GitHubSettingsInput,
} from "../../../../../../shared/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel, FieldDescription } from "@/components/ui/field";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { BrandIcon } from "../../ProviderIcon";
import githubIcon from "@lobehub/icons-static-svg/icons/github.svg?url";
import { useAppTranslation } from "@/i18n";

export function GitHubSettings({
  connection,
  refresh,
  onSuccess,
  onClose,
}: {
  connection?: GitHubConnection;
  refresh: () => Promise<unknown>;
  onSuccess: (message: string) => void;
  onClose: () => void;
}) {
  const { t } = useAppTranslation();
  const [form, setForm] = useState<GitHubSettingsInput>({
    url: connection?.url ?? "",
    token: "",
  });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const update = (patch: Partial<GitHubSettingsInput>) => {
    setForm((current) => ({ ...current, ...patch }));
    setResult("");
    setError("");
  };
  async function act(action: "save" | "test" | "remove") {
    setBusy(true);
    setResult("");
    setError("");
    try {
      if (action !== "remove" && !form.url.trim())
        throw new Error(t("connectors.github.enterAGitHubURL"));
      if (action === "test")
        setResult(await window.worklens.invoke("githubTest", form));
      else if (action === "save") {
        await window.worklens.invoke("githubSave", form);
        setForm((current) => ({ ...current, token: "" }));
        await refresh();
        onSuccess(t("connectors.github.githubSettingsSaved"));
        onClose();
      } else {
        await window.worklens.invoke("githubRemove", undefined);
        setForm({ url: "", token: "" });
        await refresh();
        onSuccess(t("connectors.github.githubDisconnected"));
        onClose();
      }
    } catch (e) {
      if (action === "save") await refresh().catch(() => {});
      setError(String(e).replace(/^Error: /, ""));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="settings-dialog" aria-busy={busy}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BrandIcon source={githubIcon} />
            GitHub
          </DialogTitle>
          <DialogDescription>
            {t("connectors.github.description")}
          </DialogDescription>
        </DialogHeader>
        {connection?.error && (
          <p role="alert" className="settings-entry-description">
            {connection.error}
          </p>
        )}
        {connection?.login && (
          <p className="text-sm">
            {t("connectors.github.account")}: {connection.login}
            {connection.serverVersion
              ? ` · Enterprise ${connection.serverVersion}`
              : ""}
          </p>
        )}
        <form
          id="github-settings-form"
          onSubmit={(event) => {
            event.preventDefault();
            void act("save");
          }}
        >
          <fieldset disabled={busy} className="flex flex-col gap-4">
            <Field>
              <FieldLabel htmlFor="github-url">
                {t("connectors.github.githubURL")}
              </FieldLabel>
              <Input
                id="github-url"
                value={form.url}
                onChange={(e) => update({ url: e.target.value, token: "" })}
                placeholder={t("connectors.github.enterYourGitHubSiteURL")}
                autoComplete="off"
              />
              <FieldDescription>
                {t("connectors.github.urlHelp")}
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="github-token">
                Personal Access Token
              </FieldLabel>
              <Input
                id="github-token"
                type="password"
                autoComplete="new-password"
                value={form.token ?? ""}
                onChange={(e) => update({ token: e.target.value })}
                placeholder={
                  connection?.configured && form.url === connection.url
                    ? t("connectors.github.leaveBlankToKeepTheSavedToken")
                    : t("connectors.github.enterYourToken")
                }
              />
              <FieldDescription>
                {t("connectors.github.tokenHelp")}
              </FieldDescription>
            </Field>
          </fieldset>
        </form>
        {error && (
          <p role="alert" className="settings-entry-description">
            {error}
          </p>
        )}
        {result && (
          <p role="status" className="text-sm">
            {result}
          </p>
        )}
        <DialogFooter>
          {connection?.url && (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => void act("remove")}
            >
              {t("common.disconnect")}
            </Button>
          )}
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void act("test")}
          >
            {t("connectors.github.testConnection")}
          </Button>
          <Button type="submit" form="github-settings-form" disabled={busy}>
            {busy ? t("common.workingPlaceholder") : t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
