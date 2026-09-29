import { savedCredentialPlaceholder } from "../../credential-placeholder";
import { completeSiteUrl } from "../site-url";
import { useState } from "react";
import type {
  JevConnection,
  JevSettingsInput,
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
import typesafe from "@/assets/brands/typesafe.svg?url";
import type { ConversationView } from "../../../../../../shared/contracts";
import { useAppTranslation } from "@/i18n";

/** Default API address; the field lets a proxy stand in for it. */
const JEV_API_URL = "https://api.typesafe.ai";
/** Where API keys are issued; signed-out visitors are sent to sign up. */
const JEV_KEYS_URL = "https://console.typesafe.ai";

export function JevSettings({
  connection,
  refresh,
  onSuccess,
  onClose,
  conversation,
  onConsentChange,
}: {
  conversation?: ConversationView;
  onConsentChange?: (view: ConversationView) => void;
  connection?: JevConnection;
  refresh: () => Promise<unknown>;
  onSuccess: (message: string) => void;
  onClose: () => void;
}) {
  const { t, language } = useAppTranslation();
  const [form, setForm] = useState<JevSettingsInput>({
    url: connection?.url || JEV_API_URL,
    token: "",
  });
  const validation = useConnectorForm("jev", form, connection);
  const update = (patch: Partial<JevSettingsInput>) => {
    setForm((current) => ({ ...current, ...patch }));
    validation.reset();
  };
  const { action, busy, act } = useConnectorAction({
    validation,
    test: () => window.worklens.invoke("jevTest", form),
    save: () => window.worklens.invoke("jevSave", form),
    remove: () => window.worklens.invoke("jevRemove", undefined),
    afterSave: () => setForm((current) => ({ ...current, token: "" })),
    afterRemove: () => setForm({ url: JEV_API_URL, token: "" }),
    refresh: async () => {
      await refresh();
      if (conversation && onConsentChange) {
        onConsentChange(
          await window.worklens.invoke("open", { id: conversation.id }),
        );
      }
    },
    onSuccess,
    onClose,
    savedMessage: t("connectors.jev.jevSettingsSaved"),
    removedMessage: t("connectors.jev.jevDisconnected"),
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
            <BrandIcon source={typesafe} />
            Jev
          </DialogTitle>
          <DialogDescription>
            {t("connectors.jev.description")}
          </DialogDescription>
        </DialogHeader>

        <form
          id="jev-settings-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void act("save");
          }}
        >
          <fieldset disabled={busy} className="flex flex-col gap-4">
            <Field data-invalid={!!validation.fieldError("url")}>
              <FieldLabel htmlFor="jev-url">
                {t("connectors.jev.apiURL")}
                {validation.props("url")["aria-required"] && (
                  <span aria-hidden="true">*</span>
                )}
              </FieldLabel>
              <Input
                id="jev-url"
                {...validation.props("url")}
                value={form.url}
                onBlur={() => {
                  const url = completeSiteUrl(form.url);
                  if (url !== form.url) update({ url });
                }}
                onChange={(e) => update({ url: e.target.value })}
                placeholder={JEV_API_URL}
                autoComplete="off"
              />
              <FieldError id="jev-url-error">
                {validation.fieldError("url")}
              </FieldError>
            </Field>
            <Field data-invalid={!!validation.fieldError("token")}>
              <FieldLabel htmlFor="jev-token">
                API key
                {validation.props("token")["aria-required"] && (
                  <span aria-hidden="true">*</span>
                )}
              </FieldLabel>
              <Input
                id="jev-token"
                {...validation.props("token")}
                type="password"
                autoComplete="new-password"
                value={form.token ?? ""}
                onChange={(e) => update({ token: e.target.value })}
                placeholder={
                  validation.canReuseToken
                    ? savedCredentialPlaceholder
                    : t("connectors.jev.enterYourApiKey")
                }
              />
              <FieldError id="jev-token-error">
                {validation.fieldError("token")}
              </FieldError>
              <FieldDescription>
                <a
                  href={JEV_KEYS_URL}
                  onClick={(event) => {
                    event.preventDefault();
                    void window.worklens
                      .invoke("external", { url: JEV_KEYS_URL })
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
                  {t("connectors.jev.getApiKey")}
                </a>
              </FieldDescription>
            </Field>
          </fieldset>
        </form>
        <ConnectorActions
          service="jev"
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
