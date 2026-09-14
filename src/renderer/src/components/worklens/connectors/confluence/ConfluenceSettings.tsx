import { useState } from "react";
import type {
  ConfluenceConnection,
  ConfluenceSettingsInput,
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
import confluenceIcon from "@/assets/brands/confluence.svg?url";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { useAppTranslation } from "@/i18n";
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
  const { t } = useAppTranslation();
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
        onSuccess(t("connectors.confluence.confluenceSettingsSaved"));
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
        onSuccess(t("connectors.confluence.confluenceDisconnected"));
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
            <BrandIcon source={confluenceIcon} />
            Confluence
          </DialogTitle>
          <DialogDescription>
            {t("connectors.confluence.description")}
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
                {t("connectors.confluence.deployment")}
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
                {t("connectors.confluence.confluenceURL")}
              </FieldLabel>
              <Input
                id="confluence-url"
                value={form.url}
                onChange={(e) => update({ url: e.target.value })}
                placeholder="https://wiki.example.com/confluence"
                autoComplete="off"
              />
              <FieldDescription>
                {t("connectors.confluence.urlHelp")}
              </FieldDescription>
            </Field>
            {form.deployment === "cloud" && (
              <>
                <Field>
                  <FieldLabel htmlFor="confluence-email">
                    {t("connectors.confluence.atlassianAccountEmail")}
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
                    {t("connectors.confluence.tokenType")}
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
                      {t("connectors.confluence.classicAPIToken")}
                    </NativeSelectOption>
                    <NativeSelectOption value="scoped">
                      {t("connectors.confluence.apiTokenWithScopes")}
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
                      {t("connectors.confluence.cloudIdHelp")}
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
                    ? t("connectors.confluence.leaveBlankToKeepTheSavedToken")
                    : t("connectors.confluence.enterYourToken")
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
            {t("connectors.confluence.testConnection")}
          </Button>
          <Button type="submit" form="confluence-settings-form" disabled={busy}>
            {busy ? t("common.workingPlaceholder") : t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
