import { useState } from "react";
import type {
  ConfluenceConnection,
  ConfluenceSettingsInput,
} from "../../../../shared/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { useLocale } from "@/lib/locale";
export function ConfluenceSettings({
  connection,
  refresh,
  onError,
  onSuccess,
}: {
  connection?: ConfluenceConnection;
  refresh: () => Promise<unknown>;
  onError: (message: string) => void;
  onSuccess: (message: string) => void;
}) {
  const { t } = useLocale();
  const [form, setForm] = useState<ConfluenceSettingsInput>({
    url: connection?.url ?? "",
    deployment: connection?.deployment ?? "data-center",
    email: connection?.email ?? "",
    cloudId: connection?.cloudId ?? "",
    token: "",
    tokenType: connection?.tokenType ?? "classic",
    access: connection?.access ?? "confirm",
  });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  const update = (patch: Partial<ConfluenceSettingsInput>) => {
    setForm((current) => ({ ...current, ...patch }));
    setResult("");
  };
  async function act(action: "save" | "test" | "remove") {
    setBusy(true);
    setResult("");
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
      } else {
        await window.worklens.invoke("confluenceRemove", undefined);
        setForm({
          url: "",
          deployment: "data-center",
          tokenType: "classic",
          access: "confirm",
          token: "",
        });
        await refresh();
        onSuccess(t("Confluence disconnected", "Confluence 已断开"));
      }
    } catch (error) {
      onError(String(error).replace(/^Error: /, ""));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="flex max-w-2xl flex-col gap-5" aria-label="Confluence">
      <div>
        <h2 className="text-lg font-medium">Confluence</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t(
            "Find information, maintain documents and work with your team's knowledge base.",
            "查找资料、维护文档，与团队知识库协作。",
          )}
        </p>
      </div>
      <p className="text-sm" role="status">
        {connection?.configured
          ? t("Configured", "已配置")
          : t("Not connected", "未连接")}
        {connection?.error ? ` · ${connection.error}` : ""}
      </p>
      <fieldset disabled={busy} className="flex flex-col gap-4">
        <div className="grid gap-2">
          <Label htmlFor="confluence-deployment">
            {t("Deployment", "部署类型")}
          </Label>
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
        </div>
        <div className="grid gap-2">
          <Label htmlFor="confluence-url">
            {t("Confluence URL", "Confluence 地址")}
          </Label>
          <Input
            id="confluence-url"
            value={form.url}
            onChange={(e) => update({ url: e.target.value })}
            placeholder="https://wiki.example.com/confluence"
            autoComplete="off"
          />
          <p className="text-xs text-muted-foreground">
            {t(
              "Use the site address, including /wiki or /confluence when present.",
              "填写站点地址，保留地址中的 /wiki 或 /confluence。",
            )}
          </p>
        </div>
        {form.deployment === "cloud" && (
          <>
            <div className="grid gap-2">
              <Label htmlFor="confluence-email">
                {t("Atlassian account email", "Atlassian 账户邮箱")}
              </Label>
              <Input
                id="confluence-email"
                type="email"
                value={form.email ?? ""}
                onChange={(e) => update({ email: e.target.value })}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="confluence-token-type">
                {t("Token type", "Token 类型")}
              </Label>
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
            </div>
            {form.tokenType === "scoped" && (
              <div className="grid gap-2">
                <Label htmlFor="confluence-cloud-id">Cloud ID</Label>
                <Input
                  id="confluence-cloud-id"
                  value={form.cloudId ?? ""}
                  onChange={(e) => update({ cloudId: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  {t(
                    "Enter your Atlassian site's Cloud ID.",
                    "填写该 Atlassian 站点的 Cloud ID。",
                  )}
                </p>
              </div>
            )}
          </>
        )}
        <div className="grid gap-2">
          <Label htmlFor="confluence-token">Token</Label>
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
        </div>
        <div className="grid gap-2">
          <Label htmlFor="confluence-access">
            {t("Allowed actions", "允许的操作")}
          </Label>
          <NativeSelect
            id="confluence-access"
            value={form.access}
            onChange={(e) =>
              update({
                access: e.target.value as ConfluenceSettingsInput["access"],
              })
            }
          >
            <NativeSelectOption value="read">
              {t("Read and download only", "仅阅读和下载")}
            </NativeSelectOption>
            <NativeSelectOption value="confirm">
              {t("Review changes before applying", "修改前查看并确认变更")}
            </NativeSelectOption>
            <NativeSelectOption value="write">
              {t("Allow changes to this Confluence", "允许修改此 Confluence")}
            </NativeSelectOption>
          </NativeSelect>
          <p className="text-xs text-muted-foreground">
            {form.access === "write"
              ? t(
                  "Authorizes WorkLens to create, edit, publish and delete content, upload files, and change page access on this connection without asking again.",
                  "授权 WorkLens 在此连接中创建、修改、发布、删除内容、上传文件和更改页面访问限制，无需再次确认。",
                )
              : t(
                  "You can change this at any time. Saved files remain when you disconnect.",
                  "可以随时调整。断开连接后，已下载的文件仍会保留。",
                )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void act("save")}>{t("Save", "保存")}</Button>
          <Button variant="outline" onClick={() => void act("test")}>
            {t("Test connection", "测试连接")}
          </Button>
          {connection?.configured && (
            <Button variant="ghost" onClick={() => void act("remove")}>
              {t("Disconnect", "断开连接")}
            </Button>
          )}
        </div>
      </fieldset>
      {result && (
        <p role="status" className="text-sm">
          {result}
        </p>
      )}
    </section>
  );
}
