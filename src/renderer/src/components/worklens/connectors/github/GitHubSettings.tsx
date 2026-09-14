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
import { useLocale } from "@/lib/locale";

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
  const { t } = useLocale();
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
        throw new Error(t("Enter a GitHub URL", "请填写 GitHub 地址"));
      if (action === "test")
        setResult(await window.worklens.invoke("githubTest", form));
      else if (action === "save") {
        await window.worklens.invoke("githubSave", form);
        setForm((current) => ({ ...current, token: "" }));
        await refresh();
        onSuccess(t("GitHub settings saved", "GitHub 设置已保存"));
        onClose();
      } else {
        await window.worklens.invoke("githubRemove", undefined);
        setForm({ url: "", token: "" });
        await refresh();
        onSuccess(t("GitHub disconnected", "GitHub 已断开"));
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
            {t(
              "Connect your GitHub site to explore code, manage issues and review pull requests.",
              "连接你的 GitHub 站点，查找代码、管理 Issue 并评审 PR。",
            )}
          </DialogDescription>
        </DialogHeader>
        {connection?.error && (
          <p role="alert" className="settings-entry-description">
            {connection.error}
          </p>
        )}
        {connection?.login && (
          <p className="text-sm">
            {t("Account", "账号")}: {connection.login}
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
                {t("GitHub URL", "GitHub 地址")}
              </FieldLabel>
              <Input
                id="github-url"
                value={form.url}
                onChange={(e) => update({ url: e.target.value, token: "" })}
                placeholder={t(
                  "Enter your GitHub site URL",
                  "填写你的 GitHub 站点地址",
                )}
                autoComplete="off"
              />
              <FieldDescription>
                {t(
                  "Use the address of GitHub.com or your company's GitHub site, without a repository path.",
                  "填写 GitHub.com 或公司 GitHub 站点的地址，不包含仓库路径。",
                )}
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
                    ? t(
                        "Leave blank to keep the saved token",
                        "留空保留已保存的 token",
                      )
                    : t("Enter your token", "填写 token")
                }
              />
              <FieldDescription>
                {t(
                  "Use a token from this site with access to the repositories and actions you need.",
                  "使用该站点的 token，并授予所需仓库和操作的权限。",
                )}
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
              {t("Disconnect", "断开连接")}
            </Button>
          )}
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void act("test")}
          >
            {t("Test connection", "测试连接")}
          </Button>
          <Button type="submit" form="github-settings-form" disabled={busy}>
            {busy ? t("Working…", "处理中…") : t("Save", "保存")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
