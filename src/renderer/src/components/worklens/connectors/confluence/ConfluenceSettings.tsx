import { savedCredentialPlaceholder } from "../../credential-placeholder";
import { completeSiteUrl } from "../site-url";
import { useState } from "react";
import type {
  ConfluenceConnection,
  ConfluenceSettingsInput,
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
  const validation = useConnectorForm("confluence", form, connection);
  const update = (patch: Partial<ConfluenceSettingsInput>) => {
    setForm((current) => ({ ...current, ...patch }));
    validation.reset();
  };
  const { action, busy, act } = useConnectorAction({
    validation,
    test: () =>
      window.worklens.invoke("confluenceTest", {
        ...form,
        email: form.email || undefined,
        cloudId: form.cloudId || undefined,
      }),
    save: () =>
      window.worklens.invoke("confluenceSave", {
        ...form,
        email: form.email || undefined,
        cloudId: form.cloudId || undefined,
      }),
    remove: () => window.worklens.invoke("confluenceRemove", undefined),
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
    savedMessage: t("connectors.confluence.confluenceSettingsSaved"),
    removedMessage: t("connectors.confluence.confluenceDisconnected"),
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
            <BrandIcon source={confluenceIcon} />
            Confluence
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("connectors.confluence.description")}
          </DialogDescription>
        </DialogHeader>

        <form
          id="confluence-settings-form"
          noValidate
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
            <Field data-invalid={!!validation.fieldError("url")}>
              <FieldLabel htmlFor="confluence-url">
                {t("connectors.confluence.confluenceURL")}
                {validation.props("url")["aria-required"] && (
                  <span aria-hidden="true">*</span>
                )}
              </FieldLabel>
              <Input
                id="confluence-url"
                {...validation.props("url")}
                value={form.url}
                onBlur={() => {
                  const url = completeSiteUrl(form.url);
                  if (url !== form.url) update({ url });
                }}
                onChange={(e) => update({ url: e.target.value })}
                placeholder="https://wiki.example.com/confluence"
                autoComplete="off"
              />
              <FieldError id="confluence-url-error">
                {validation.fieldError("url")}
              </FieldError>
            </Field>
            {form.deployment === "cloud" && (
              <>
                <Field data-invalid={!!validation.fieldError("email")}>
                  <FieldLabel htmlFor="confluence-email">
                    {t("connectors.confluence.atlassianAccountEmail")}
                    {validation.props("email")["aria-required"] && (
                      <span aria-hidden="true">*</span>
                    )}
                  </FieldLabel>
                  <Input
                    id="confluence-email"
                    {...validation.props("email")}
                    type="email"
                    value={form.email ?? ""}
                    onChange={(e) => update({ email: e.target.value })}
                  />
                  <FieldError id="confluence-email-error">
                    {validation.fieldError("email")}
                  </FieldError>
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
                  <Field data-invalid={!!validation.fieldError("cloudId")}>
                    <FieldLabel htmlFor="confluence-cloud-id">
                      Cloud ID
                      {validation.props("cloudId")["aria-required"] && (
                        <span aria-hidden="true">*</span>
                      )}
                    </FieldLabel>
                    <Input
                      id="confluence-cloud-id"
                      {...validation.props("cloudId")}
                      value={form.cloudId ?? ""}
                      onChange={(e) => update({ cloudId: e.target.value })}
                    />
                    <FieldError id="confluence-cloud-id-error">
                      {validation.fieldError("cloudId")}
                    </FieldError>
                  </Field>
                )}
              </>
            )}
            <Field data-invalid={!!validation.fieldError("token")}>
              <FieldLabel htmlFor="confluence-token">
                Token
                {validation.props("token")["aria-required"] && (
                  <span aria-hidden="true">*</span>
                )}
              </FieldLabel>
              <Input
                id="confluence-token"
                {...validation.props("token")}
                type="password"
                autoComplete="new-password"
                value={form.token ?? ""}
                onChange={(e) => update({ token: e.target.value })}
                placeholder={
                  validation.canReuseToken
                    ? savedCredentialPlaceholder
                    : t("connectors.confluence.enterYourToken")
                }
              />
              <FieldError id="confluence-token-error">
                {validation.fieldError("token")}
              </FieldError>
            </Field>
          </fieldset>
        </form>
        <ConnectorActions
          service="confluence"
          action={action}
          missing={validation.missing}
          removable={!!connection?.url}
          onAction={(next) => void act(next)}
        />
      </DialogContent>
    </Dialog>
  );
}
