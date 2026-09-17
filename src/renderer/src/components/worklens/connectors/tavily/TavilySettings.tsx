import { savedCredentialPlaceholder } from "../../credential-placeholder";
import { completeSiteUrl } from "../site-url";
import { useState } from "react";
import type {
  TavilyConnection,
  TavilySettingsInput,
} from "../../../../../../shared/contracts";
import { useConnectorForm } from "../connector-form";
import { ConnectorActions } from "../ConnectorActions";
import { useConnectorAction } from "../use-connector-action";
import { Input } from "@/components/ui/input";
import {
  Field,
  FieldLabel,
  FieldError,
  FieldDescription,
} from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import { settingsFailure } from "../../settings-notification";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { BrandIcon } from "../../ProviderIcon";
import tavilyIcon from "@lobehub/icons-static-svg/icons/tavily.svg?url";
import { useAppTranslation } from "@/i18n";

/** Default API address; the field lets a proxy stand in for it. */
const TAVILY_API_URL = "https://api.tavily.com";
/** Where API keys are issued; signed-out visitors are sent to sign up. */
const TAVILY_KEYS_URL = "https://app.tavily.com/home";

export function TavilySettings({
  connection,
  refresh,
  onSuccess,
  onClose,
}: {
  connection?: TavilyConnection;
  refresh: () => Promise<unknown>;
  onSuccess: (message: string) => void;
  onClose: () => void;
}) {
  const { t, language } = useAppTranslation();
  const [form, setForm] = useState<TavilySettingsInput>({
    url: connection?.url || TAVILY_API_URL,
    token: "",
  });
  const validation = useConnectorForm("tavily", form, connection);
  const update = (patch: Partial<TavilySettingsInput>) => {
    setForm((current) => ({ ...current, ...patch }));
    validation.reset();
  };
  const { action, busy, act } = useConnectorAction({
    validation,
    test: () => window.worklens.invoke("tavilyTest", form),
    save: () => window.worklens.invoke("tavilySave", form),
    remove: () => window.worklens.invoke("tavilyRemove", undefined),
    afterSave: () => setForm((current) => ({ ...current, token: "" })),
    afterRemove: () => setForm({ url: TAVILY_API_URL, token: "" }),
    refresh,
    onSuccess,
    onClose,
    savedMessage: t("connectors.tavily.tavilySettingsSaved"),
    removedMessage: t("connectors.tavily.tavilyDisconnected"),
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
            <BrandIcon source={tavilyIcon} />
            Tavily
          </DialogTitle>
          <DialogDescription>
            {t("connectors.tavily.description")}
          </DialogDescription>
        </DialogHeader>

        {connection?.plan && (
          <p className="text-sm">
            {t("connectors.tavily.plan")}: {connection.plan}
          </p>
        )}
        <form
          id="tavily-settings-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void act("save");
          }}
        >
          <fieldset disabled={busy} className="flex flex-col gap-4">
            <Field data-invalid={!!validation.fieldError("url")}>
              <FieldLabel htmlFor="tavily-url">
                {t("connectors.tavily.apiURL")}
                {validation.props("url")["aria-required"] && (
                  <span aria-hidden="true">*</span>
                )}
              </FieldLabel>
              <Input
                id="tavily-url"
                {...validation.props("url")}
                value={form.url}
                onBlur={() => {
                  const url = completeSiteUrl(form.url);
                  if (url !== form.url) update({ url });
                }}
                onChange={(e) => update({ url: e.target.value })}
                placeholder={TAVILY_API_URL}
                autoComplete="off"
              />
              <FieldError id="tavily-url-error">
                {validation.fieldError("url")}
              </FieldError>
            </Field>
            <Field data-invalid={!!validation.fieldError("token")}>
              <FieldLabel htmlFor="tavily-token">
                API key
                {validation.props("token")["aria-required"] && (
                  <span aria-hidden="true">*</span>
                )}
              </FieldLabel>
              <Input
                id="tavily-token"
                {...validation.props("token")}
                type="password"
                autoComplete="new-password"
                value={form.token ?? ""}
                onChange={(e) => update({ token: e.target.value })}
                placeholder={
                  validation.canReuseToken
                    ? savedCredentialPlaceholder
                    : t("connectors.tavily.enterYourApiKey")
                }
              />
              <FieldError id="tavily-token-error">
                {validation.fieldError("token")}
              </FieldError>
              <FieldDescription>
                <a
                  href={TAVILY_KEYS_URL}
                  onClick={(event) => {
                    event.preventDefault();
                    void window.worklens
                      .invoke("external", { url: TAVILY_KEYS_URL })
                      .catch((e) =>
                        toast.add(
                          settingsFailure(
                            t("settingsFeedback.browserFailed"),
                            String(e),
                            language,
                          ),
                        ),
                      );
                  }}
                >
                  {t("connectors.tavily.getApiKey")}
                </a>
              </FieldDescription>
            </Field>
          </fieldset>
        </form>
        <ConnectorActions
          service="tavily"
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
