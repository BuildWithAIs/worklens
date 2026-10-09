import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Settings2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { toast } from "@/components/ui/toast";
import { useAppTranslation } from "@/i18n";
import type {
  ProxyDetection,
  ProxySettings,
  Settings,
} from "../../../../shared/contracts";
import { normalizeProxyUrl } from "../../../../shared/network-proxy";
import { settingsFailure } from "./settings-notification";

const SYSTEM: ProxySettings = { mode: "system" };

export function NetworkProxySetting({
  proxy = SYSTEM,
  save,
  onSuccess,
}: {
  proxy?: ProxySettings;
  save: (patch: Partial<Settings>) => Promise<void>;
  onSuccess: (message: string) => void;
}) {
  const { t, language } = useAppTranslation();
  const [detection, setDetection] = useState<ProxyDetection>();
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const saving = useRef(false);
  useEffect(() => {
    let active = true;
    void window.worklens
      .invoke("proxyDetect", {})
      .catch(() => ({}))
      .then((result) => {
        if (active) setDetection(result ?? {});
      });
    return () => {
      active = false;
    };
  }, [proxy.mode]);

  async function apply(next: ProxySettings) {
    if (saving.current) return false;
    saving.current = true;
    setPending(true);
    try {
      await save({ proxy: next });
      return true;
    } catch (error) {
      toast.add(
        settingsFailure(
          t("settings.proxySaveFailed"),
          String(error),
          language,
          false,
          t("settingsFeedback.unknown"),
        ),
      );
      return false;
    } finally {
      saving.current = false;
      setPending(false);
    }
  }

  const status =
    proxy.mode === "off"
      ? t("settings.proxyDirect")
      : proxy.mode === "custom"
        ? t("settings.proxyUsing", { proxy: proxy.url ?? "" })
        : !detection
          ? t("settings.proxyChecking")
          : detection.system
            ? t("settings.proxyUsing", { proxy: detection.system })
            : detection.unsupported
              ? t("settings.proxyUnsupported")
              : t("settings.proxyNoSystem");

  return (
    <section className="settings-section">
      <h2 className="settings-group-bar" data-slot="settings-section-title">
        {t("settings.network")}
      </h2>
      <ItemGroup className="settings-list">
        <Item
          size="sm"
          role="listitem"
          className="settings-entry"
          data-network-proxy
        >
          <ItemContent className="settings-entry-copy">
            <ItemTitle className="settings-entry-title">
              {t("settings.proxy")}
            </ItemTitle>
            <ItemDescription
              className="settings-entry-description"
              id="network-proxy-status"
              role="status"
            >
              {status}
            </ItemDescription>
          </ItemContent>
          <ItemActions className="settings-entry-actions">
            {proxy.mode === "custom" && (
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => setEditing(true)}
                aria-label={t("settings.proxyEditLabel")}
              >
                <Settings2 data-icon="inline-start" aria-hidden="true" />
                {t("settings.proxyEdit")}
              </Button>
            )}
            <NativeSelect
              aria-label={t("settings.proxy")}
              aria-describedby="network-proxy-status"
              aria-busy={pending}
              disabled={pending}
              value={editing ? "custom" : proxy.mode}
              onChange={(event) => {
                const mode = event.target.value as ProxySettings["mode"];
                // A custom proxy is applied only after it is saved in the dialog.
                if (mode === "custom") setEditing(true);
                else void apply({ ...proxy, mode });
              }}
            >
              <NativeSelectOption value="system">
                {t("settings.proxySystem")}
              </NativeSelectOption>
              <NativeSelectOption value="custom">
                {t("settings.proxyCustom")}
              </NativeSelectOption>
              <NativeSelectOption value="off">
                {t("settings.proxyOff")}
              </NativeSelectOption>
            </NativeSelect>
          </ItemActions>
        </Item>
      </ItemGroup>
      {editing && (
        <CustomProxyDialog
          proxy={proxy}
          detection={detection}
          onSave={async (next) => {
            if (!(await apply(next))) return;
            setEditing(false);
            onSuccess(t("settings.proxySaved"));
          }}
          onClose={() => setEditing(false)}
        />
      )}
    </section>
  );
}

function CustomProxyDialog({
  proxy,
  detection,
  onSave,
  onClose,
}: {
  proxy: ProxySettings;
  detection?: ProxyDetection;
  onSave: (proxy: ProxySettings) => Promise<void>;
  onClose: () => void;
}) {
  const { t, language } = useAppTranslation();
  const [source, setSource] = useState<"system" | "environment">();
  const [url, setUrl] = useState(proxy.url ?? "");
  const [bypass, setBypass] = useState(proxy.bypass ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"test" | "save">();
  const filled = useRef(false);
  const input = useRef<HTMLInputElement>(null);

  // Fill in a detected proxy once, reading the login shell only when needed.
  useEffect(() => {
    if (proxy.url || filled.current) return;
    filled.current = true;
    const fill = (value: string, from: "system" | "environment") => {
      setUrl((current) => current || value);
      setSource(from);
    };
    if (detection?.system) fill(detection.system, "system");
    else if (detection?.environment) fill(detection.environment, "environment");
    else
      void window.worklens
        .invoke("proxyDetect", { shell: true })
        .then((result) => {
          if (result.system) fill(result.system, "system");
          else if (result.environment) fill(result.environment, "environment");
        })
        .catch(() => {});
  }, [proxy.url, detection]);

  function validate() {
    const normalized = normalizeProxyUrl(url);
    setError(
      normalized
        ? ""
        : t(
            url.trim()
              ? "settings.proxyAddressInvalid"
              : "settings.proxyAddressRequired",
          ),
    );
    if (!normalized) input.current?.focus();
    return normalized;
  }
  function draft(normalized: string): ProxySettings {
    return {
      mode: "custom",
      url: normalized,
      ...(bypass.trim() ? { bypass: bypass.trim() } : {}),
    };
  }
  async function test() {
    const normalized = validate();
    if (!normalized) return;
    setBusy("test");
    try {
      const result = await window.worklens.invoke(
        "proxyTest",
        draft(normalized),
      );
      toast.add({
        type: "success",
        timeout: 3200,
        title: t("settings.proxyConnected"),
        description: t("settings.proxyThrough", {
          proxy: result.proxy ?? normalized,
        }),
      });
    } catch (failure) {
      toast.add(
        settingsFailure(
          t("settings.proxyTestFailed"),
          String(failure),
          language,
          false,
          t("settingsFeedback.unknown"),
        ),
      );
    } finally {
      setBusy(undefined);
    }
  }
  async function submit() {
    const normalized = validate();
    if (!normalized) return;
    setBusy("save");
    try {
      await onSave(draft(normalized));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        className="settings-dialog"
        initialFocus={input}
        aria-busy={!!busy}
        showCloseButton={!busy}
      >
        <DialogHeader>
          <DialogTitle>{t("settings.proxyDialogTitle")}</DialogTitle>
          <DialogDescription>
            {t("settings.proxyDialogDescription")}
          </DialogDescription>
        </DialogHeader>
        <form
          id="network-proxy-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <fieldset disabled={!!busy} className="flex flex-col gap-4">
            <Field data-invalid={!!error}>
              <FieldLabel htmlFor="network-proxy-url">
                {t("settings.proxyAddress")}
              </FieldLabel>
              <Input
                ref={input}
                id="network-proxy-url"
                value={url}
                placeholder="http://127.0.0.1:7890"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={!!error}
                aria-describedby={
                  error
                    ? "network-proxy-url-error"
                    : source
                      ? "network-proxy-url-hint"
                      : undefined
                }
                onChange={(event) => {
                  setUrl(event.target.value);
                  setSource(undefined);
                  setError("");
                }}
              />
              {!error && source && (
                <FieldDescription id="network-proxy-url-hint">
                  {t(
                    source === "system"
                      ? "settings.proxyFromSystem"
                      : "settings.proxyFromShell",
                  )}
                </FieldDescription>
              )}
              <FieldError id="network-proxy-url-error">{error}</FieldError>
            </Field>
            <Field>
              <FieldLabel htmlFor="network-proxy-bypass">
                {t("settings.proxyBypass")}
              </FieldLabel>
              <Input
                id="network-proxy-bypass"
                value={bypass}
                placeholder="example.com, *.internal"
                autoComplete="off"
                spellCheck={false}
                aria-describedby="network-proxy-bypass-hint"
                onChange={(event) => setBypass(event.target.value)}
              />
              <FieldDescription id="network-proxy-bypass-hint">
                {t("settings.proxyBypassHint")}
              </FieldDescription>
            </Field>
          </fieldset>
        </form>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={!!busy || !url.trim()}
            onClick={() => void test()}
          >
            {busy === "test" ? (
              <LoaderCircle
                className="animate-spin motion-reduce:animate-none"
                data-icon="inline-start"
                aria-hidden="true"
              />
            ) : (
              <Zap data-icon="inline-start" aria-hidden="true" />
            )}
            {t(
              busy === "test" ? "settings.proxyTesting" : "settings.proxyTest",
            )}
          </Button>
          <Button
            type="submit"
            className="w-24"
            form="network-proxy-form"
            disabled={!!busy || !url.trim()}
          >
            {busy === "save" && (
              <LoaderCircle
                className="animate-spin motion-reduce:animate-none"
                data-icon="inline-start"
                aria-hidden="true"
              />
            )}
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
