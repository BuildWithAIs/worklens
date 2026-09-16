import { savedCredentialPlaceholder } from "../../credential-placeholder";
import { completeSiteUrl } from "../site-url";
import { useState } from "react";
import type {
  GitHubConnection,
  GitHubSettingsInput,
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
  const validation = useConnectorForm("github", form, connection);
  const update = (patch: Partial<GitHubSettingsInput>) => {
    setForm((current) => ({ ...current, ...patch }));
    validation.reset();
  };
  const { action, busy, act } = useConnectorAction({
    validation,
    test: () => window.worklens.invoke("githubTest", form),
    save: () => window.worklens.invoke("githubSave", form),
    remove: () => window.worklens.invoke("githubRemove", undefined),
    afterSave: () => setForm((current) => ({ ...current, token: "" })),
    afterRemove: () => setForm({ url: "", token: "" }),
    refresh,
    onSuccess,
    onClose,
    savedMessage: t("connectors.github.githubSettingsSaved"),
    removedMessage: t("connectors.github.githubDisconnected"),
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
            <BrandIcon source={githubIcon} />
            GitHub
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("connectors.github.description")}
          </DialogDescription>
        </DialogHeader>

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
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void act("save");
          }}
        >
          <fieldset disabled={busy} className="flex flex-col gap-4">
            <Field data-invalid={!!validation.fieldError("url")}>
              <FieldLabel htmlFor="github-url">
                {t("connectors.github.githubURL")}
                {validation.props("url")["aria-required"] && (
                  <span aria-hidden="true">*</span>
                )}
              </FieldLabel>
              <Input
                id="github-url"
                {...validation.props("url")}
                value={form.url}
                onBlur={() => {
                  const url = completeSiteUrl(form.url);
                  if (url !== form.url) update({ url });
                }}
                onChange={(e) => update({ url: e.target.value })}
                placeholder={t("connectors.github.enterYourGitHubSiteURL")}
                autoComplete="off"
              />
              <FieldError id="github-url-error">
                {validation.fieldError("url")}
              </FieldError>
            </Field>
            <Field data-invalid={!!validation.fieldError("token")}>
              <FieldLabel htmlFor="github-token">
                Personal Access Token
                {validation.props("token")["aria-required"] && (
                  <span aria-hidden="true">*</span>
                )}
              </FieldLabel>
              <Input
                id="github-token"
                {...validation.props("token")}
                type="password"
                autoComplete="new-password"
                value={form.token ?? ""}
                onChange={(e) => update({ token: e.target.value })}
                placeholder={
                  validation.canReuseToken
                    ? savedCredentialPlaceholder
                    : t("connectors.github.enterYourToken")
                }
              />
              <FieldError id="github-token-error">
                {validation.fieldError("token")}
              </FieldError>
            </Field>
          </fieldset>
        </form>
        <ConnectorActions
          service="github"
          action={action}
          missing={validation.missing}
          unchanged={validation.unchanged}
          removable={!!connection?.url}
          onAction={(next) => void act(next)}
        />
      </DialogContent>
    </Dialog>
  );
}
