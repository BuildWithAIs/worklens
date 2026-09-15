import { savedCredentialPlaceholder } from "../../credential-placeholder";
import { completeSiteUrl } from "../site-url";
import { useState } from "react";
import type {
  JiraConnection,
  JiraSettingsInput,
} from "../../../../../../shared/contracts";
import { useConnectorForm } from "../connector-form";
import { ConnectorActions } from "../ConnectorActions";
import { useConnectorAction } from "../use-connector-action";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel, FieldError } from "@/components/ui/field";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
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
  const validation = useConnectorForm("jira", form, connection);
  const update = (patch: Partial<JiraSettingsInput>) => {
    setForm((current) => ({ ...current, ...patch }));
    validation.reset();
  };
  const { action, busy, act } = useConnectorAction({
    validation,
    test: () =>
      window.worklens.invoke("jiraTest", {
        ...form,
        email: form.email || undefined,
        cloudId: form.cloudId || undefined,
      }),
    save: () =>
      window.worklens.invoke("jiraSave", {
        ...form,
        email: form.email || undefined,
        cloudId: form.cloudId || undefined,
      }),
    remove: () => window.worklens.invoke("jiraRemove", undefined),
    afterSave: () => setForm((current) => ({ ...current, token: "" })),
    afterRemove: () =>
      setForm({
        url: "",
        deployment: "data-center",
        tokenType: "classic",
        token: "",
      }),
    refresh,
    onSuccess,
    onClose,
    savedMessage: t("connectors.jira.jiraSettingsSaved"),
    removedMessage: t("connectors.jira.jiraDisconnected"),
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        className="settings-dialog settings-connector-dialog"
        aria-busy={busy}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BrandIcon source={jiraIcon} />
            Jira
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("connectors.jira.description")}
          </DialogDescription>
        </DialogHeader>

        <form
          id="jira-settings-form"
          noValidate
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
            <Field data-invalid={!!validation.fieldError("url")}>
              <FieldLabel htmlFor="jira-url">
                {t("connectors.jira.jiraURL")}
                {validation.props("url")["aria-required"] && (
                  <span aria-hidden="true">*</span>
                )}
              </FieldLabel>
              <Input
                id="jira-url"
                {...validation.props("url")}
                value={form.url}
                onBlur={() => {
                  const url = completeSiteUrl(form.url);
                  if (url !== form.url) update({ url });
                }}
                onChange={(e) => update({ url: e.target.value })}
                placeholder="https://jira.example.com/jira"
                autoComplete="off"
              />
              <FieldError id="jira-url-error">
                {validation.fieldError("url")}
              </FieldError>
            </Field>
            {form.deployment === "cloud" && (
              <>
                <Field data-invalid={!!validation.fieldError("email")}>
                  <FieldLabel htmlFor="jira-email">
                    {t("connectors.jira.atlassianAccountEmail")}
                    {validation.props("email")["aria-required"] && (
                      <span aria-hidden="true">*</span>
                    )}
                  </FieldLabel>
                  <Input
                    id="jira-email"
                    {...validation.props("email")}
                    type="email"
                    value={form.email ?? ""}
                    onChange={(e) => update({ email: e.target.value })}
                  />
                  <FieldError id="jira-email-error">
                    {validation.fieldError("email")}
                  </FieldError>
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
                  <Field data-invalid={!!validation.fieldError("cloudId")}>
                    <FieldLabel htmlFor="jira-cloud-id">
                      Cloud ID
                      {validation.props("cloudId")["aria-required"] && (
                        <span aria-hidden="true">*</span>
                      )}
                    </FieldLabel>
                    <Input
                      id="jira-cloud-id"
                      {...validation.props("cloudId")}
                      value={form.cloudId ?? ""}
                      onChange={(e) => update({ cloudId: e.target.value })}
                    />
                    <FieldError id="jira-cloud-id-error">
                      {validation.fieldError("cloudId")}
                    </FieldError>
                  </Field>
                )}
              </>
            )}
            <Field data-invalid={!!validation.fieldError("token")}>
              <FieldLabel htmlFor="jira-token">
                Token
                {validation.props("token")["aria-required"] && (
                  <span aria-hidden="true">*</span>
                )}
              </FieldLabel>
              <Input
                id="jira-token"
                {...validation.props("token")}
                type="password"
                autoComplete="new-password"
                value={form.token ?? ""}
                onChange={(e) => update({ token: e.target.value })}
                placeholder={
                  validation.canReuseToken
                    ? savedCredentialPlaceholder
                    : t("connectors.jira.enterYourToken")
                }
              />
              <FieldError id="jira-token-error">
                {validation.fieldError("token")}
              </FieldError>
            </Field>
          </fieldset>
        </form>
        <ConnectorActions
          service="jira"
          action={action}
          missing={validation.missing}
          removable={!!connection?.url}
          onAction={(next) => void act(next)}
        />
      </DialogContent>
    </Dialog>
  );
}
