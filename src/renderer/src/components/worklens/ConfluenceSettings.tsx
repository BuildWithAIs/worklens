import { useState } from "react";
import type {
  ConfluenceConnection,
  ConfluenceSettingsInput,
} from "../../../../shared/contracts";
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
import { BrandIcon } from "./ProviderIcon";
import confluenceIcon from "@/assets/brands/confluence.svg?url";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { useLocale } from "@/lib/locale";
export function ConfluenceSettings({
  connection,
  refresh,
  onSuccess,
  onClose,
}: {
  connection?: ConfluenceConnection;
  refresh: () => Promise<unknown>;
  onSuccess: (message: string) => void;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const [form, setForm] = useState<ConfluenceSettingsInput>({
    url: connection?.url ?? "",
    deployment: connection?.deployment ?? "data-center",
    email: connection?.email ?? "",
    cloudId: connection?.cloudId ?? "",
    token: "",
    tokenType: connection?.tokenType ?? "classic",
  });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const update = (patch: Partial<ConfluenceSettingsInput>) => {
    setForm((current) => ({ ...current, ...patch }));
    setResult("");
    setError("");
  };
  async function act(action: "save" | "test" | "remove") {
    setBusy(true);
    setResult("");
    setError("");
    try {
      const input = {
        ...form,
        email: form.email || undefined,
        cloudId: form.cloudId || undefined,
      };
      if (action === "test")
        setResult(await window.worklens.invoke("confluenceTest", input));
      else if (action === "save") {
        await window.worklens.invoke("confluenceSave", input);
        setForm((current) => ({ ...current, token: "" }));
        await refresh();
        onSuccess(t("Confluence settings saved", "Confluence 设置已保存"));
        onClose();
      } else {
        await window.worklens.invoke("confluenceRemove", undefined);
        setForm({
          url: "",
          deployment: "data-center",
          tokenType: "classic",
          token: "",
        });
        await refresh();
        onSuccess(t("Confluence disconnected", "Confluence 已断开"));
        onClose();
      }
    } catch (error) {
      const message = String(error).replace(/^Error: /, "");
      setError(message);
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
            <BrandIcon source={confluenceIcon} />
            Confluence
          </DialogTitle>
          <DialogDescription>
            {t(
              "Connect your team's knowledge base to search and maintain documents.",
              "连接团队知识库，搜索资料并维护文档。",
            )}
          </DialogDescription>
        </DialogHeader>
        {connection?.error && (
          <p role="alert" className="settings-entry-description">
            {connection.error}
          </p>
        )}
        <form
          id="confluence-settings-form"
          onSubmit={(event) => {
            event.preventDefault();
            void act("save");
          }}
        >
          <fieldset disabled={busy} className="flex flex-col gap-4">
            <Field>
              <FieldLabel htmlFor="confluence-deployment">
                {t("Deployment", "部署类型")}
              </FieldLabel>
              <NativeSelect
                id="confluence-deployment"
                value={form.deployment}
                onChange={(e) =>
                  update({
                    deployment: e.target
                      .value as ConfluenceSettingsInput["deployment"],
                    token: "",
                  })
                }
              >
                <NativeSelectOption value="data-center">
                  Data Center
                </NativeSelectOption>
                <NativeSelectOption value="cloud">Cloud</NativeSelectOption>
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="confluence-url">
                {t("Confluence URL", "Confluence 地址")}
              </FieldLabel>
              <Input
                id="confluence-url"
                value={form.url}
                onChange={(e) => update({ url: e.target.value })}
                placeholder="https://wiki.example.com/confluence"
                autoComplete="off"
              />
              <FieldDescription>
                {t(
                  "Use the site address, including /wiki or /confluence when present.",
                  "填写站点地址，保留地址中的 /wiki 或 /confluence。",
                )}
              </FieldDescription>
            </Field>
            {form.deployment === "cloud" && (
              <>
                <Field>
                  <FieldLabel htmlFor="confluence-email">
                    {t("Atlassian account email", "Atlassian 账户邮箱")}
                  </FieldLabel>
                  <Input
                    id="confluence-email"
                    type="email"
                    value={form.email ?? ""}
                    onChange={(e) => update({ email: e.target.value })}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="confluence-token-type">
                    {t("Token type", "Token 类型")}
                  </FieldLabel>
                  <NativeSelect
                    id="confluence-token-type"
                    value={form.tokenType}
                    onChange={(e) =>
                      update({
                        tokenType: e.target.value as "classic" | "scoped",
                        token: "",
                      })
                    }
                  >
                    <NativeSelectOption value="classic">
                      {t("Classic API token", "普通 API token")}
                    </NativeSelectOption>
                    <NativeSelectOption value="scoped">
                      {t("API token with scopes", "带 scopes 的 API token")}
                    </NativeSelectOption>
                  </NativeSelect>
                </Field>
                {form.tokenType === "scoped" && (
                  <Field>
                    <FieldLabel htmlFor="confluence-cloud-id">
                      Cloud ID
                    </FieldLabel>
                    <Input
                      id="confluence-cloud-id"
                      value={form.cloudId ?? ""}
                      onChange={(e) => update({ cloudId: e.target.value })}
                    />
                    <FieldDescription>
                      {t(
                        "Enter your Atlassian site's Cloud ID.",
                        "填写该 Atlassian 站点的 Cloud ID。",
                      )}
                    </FieldDescription>
                  </Field>
                )}
              </>
            )}
            <Field>
              <FieldLabel htmlFor="confluence-token">Token</FieldLabel>
              <Input
                id="confluence-token"
                type="password"
                autoComplete="new-password"
                value={form.token ?? ""}
                onChange={(e) => update({ token: e.target.value })}
                placeholder={
                  connection?.configured
                    ? t(
                        "Leave blank to keep the saved token",
                        "留空保留已保存的 token",
                      )
                    : t("Enter your token", "填写 token")
                }
              />
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
          {connection?.configured && (
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
          <Button type="submit" form="confluence-settings-form" disabled={busy}>
            {busy ? t("Working…", "处理中…") : t("Save", "保存")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
