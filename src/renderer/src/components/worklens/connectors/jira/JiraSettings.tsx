import { useState } from "react";
import type {
  JiraConnection,
  JiraSettingsInput,
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
import jiraIcon from "@/assets/brands/jira.svg?url";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { useAppTranslation } from "@/i18n";
export function JiraSettings({
  connection,
  refresh,
  onSuccess,
  onClose,
}: {
  connection?: JiraConnection;
  refresh: () => Promise<unknown>;
  onSuccess: (message: string) => void;
  onClose: () => void;
}) {
  const { t } = useAppTranslation();
  const [form, setForm] = useState<JiraSettingsInput>({
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
  const update = (patch: Partial<JiraSettingsInput>) => {
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
        setResult(await window.worklens.invoke("jiraTest", input));
      else if (action === "save") {
        await window.worklens.invoke("jiraSave", input);
        setForm((current) => ({ ...current, token: "" }));
        await refresh();
        onSuccess(t("connectors.jira.jiraSettingsSaved"));
        onClose();
      } else {
        await window.worklens.invoke("jiraRemove", undefined);
        setForm({
          url: "",
          deployment: "data-center",
          tokenType: "classic",
          token: "",
        });
        await refresh();
        onSuccess(t("connectors.jira.jiraDisconnected"));
        onClose();
      }
    } catch (error) {
      if (action === "save") await refresh().catch(() => {});
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
            <BrandIcon source={jiraIcon} />
            Jira
          </DialogTitle>
          <DialogDescription>
            {t("connectors.jira.description")}
          </DialogDescription>
        </DialogHeader>
        {connection?.error && (
          <p role="alert" className="settings-entry-description">
            {connection.error}
          </p>
        )}
        <form
          id="jira-settings-form"
          onSubmit={(event) => {
            event.preventDefault();
            void act("save");
          }}
        >
          <fieldset disabled={busy} className="flex flex-col gap-4">
            <Field>
              <FieldLabel htmlFor="jira-deployment">
                {t("connectors.jira.deployment")}
              </FieldLabel>
              <NativeSelect
                id="jira-deployment"
                value={form.deployment}
                onChange={(e) =>
                  update({
                    deployment: e.target
                      .value as JiraSettingsInput["deployment"],
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
              <FieldLabel htmlFor="jira-url">
                {t("connectors.jira.jiraURL")}
              </FieldLabel>
              <Input
                id="jira-url"
                value={form.url}
                onChange={(e) => update({ url: e.target.value })}
                placeholder="https://jira.example.com/jira"
                autoComplete="off"
              />
              <FieldDescription>
                {t("connectors.jira.urlHelp")}
              </FieldDescription>
            </Field>
            {form.deployment === "cloud" && (
              <>
                <Field>
                  <FieldLabel htmlFor="jira-email">
                    {t("connectors.jira.atlassianAccountEmail")}
                  </FieldLabel>
                  <Input
                    id="jira-email"
                    type="email"
                    value={form.email ?? ""}
                    onChange={(e) => update({ email: e.target.value })}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="jira-token-type">
                    {t("connectors.jira.tokenType")}
                  </FieldLabel>
                  <NativeSelect
                    id="jira-token-type"
                    value={form.tokenType}
                    onChange={(e) =>
                      update({
                        tokenType: e.target.value as "classic" | "scoped",
                        token: "",
                      })
                    }
                  >
                    <NativeSelectOption value="classic">
                      {t("connectors.jira.classicAPIToken")}
                    </NativeSelectOption>
                    <NativeSelectOption value="scoped">
                      {t("connectors.jira.apiTokenWithScopes")}
                    </NativeSelectOption>
                  </NativeSelect>
                </Field>
                {form.tokenType === "scoped" && (
                  <Field>
                    <FieldLabel htmlFor="jira-cloud-id">Cloud ID</FieldLabel>
                    <Input
                      id="jira-cloud-id"
                      value={form.cloudId ?? ""}
                      onChange={(e) => update({ cloudId: e.target.value })}
                    />
                    <FieldDescription>
                      {t("connectors.jira.cloudIdHelp")}
                    </FieldDescription>
                  </Field>
                )}
              </>
            )}
            <Field>
              <FieldLabel htmlFor="jira-token">Token</FieldLabel>
              <Input
                id="jira-token"
                type="password"
                autoComplete="new-password"
                value={form.token ?? ""}
                onChange={(e) => update({ token: e.target.value })}
                placeholder={
                  connection?.configured
                    ? t("connectors.jira.leaveBlankToKeepTheSavedToken")
                    : t("connectors.jira.enterYourToken")
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
            {t("connectors.jira.testConnection")}
          </Button>
          <Button type="submit" form="jira-settings-form" disabled={busy}>
            {busy ? t("common.workingPlaceholder") : t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
