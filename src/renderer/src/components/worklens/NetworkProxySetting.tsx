import { useCallback, useEffect, useRef, useState } from "react";
import { CircleAlert, LoaderCircle, Pencil, Zap } from "lucide-react";
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
import { Hint } from "@/components/ui/tooltip";
import { useAppTranslation } from "@/i18n";
import type {
  ProxyDetection,
  NetworkStatus,
  ProxySettings,
  Settings,
} from "../../../../shared/contracts";
import { normalizeProxyUrl } from "../../../../shared/network-proxy";
import { settingsFailure } from "./settings-notification";
import { SettingsConnectionWarning } from "./SettingsConnectionWarning";

const SYSTEM: ProxySettings = { mode: "system" };

type Translate = ReturnType<typeof useAppTranslation>["t"];

/** Tests `settings`, announcing success; returns the failure to show inline. */
async function testConnection(
  settings: ProxySettings,
  t: Translate,
  current: () => boolean,
) {
  try {
    const result = await window.worklens.invoke("proxyTest", settings);
    if (!current()) return "";
    toast.add({
      type: "success",
      timeout: 3200,
      title: t(
        result.proxy
          ? "settings.proxyConnected"
          : "settings.connectionSuccessful",
      ),
      description: result.proxy
        ? t("settings.proxyThrough", { proxy: result.proxy })
        : t("settings.proxyConnectedDirect"),
    });
    return "";
  } catch (failure) {
    // The test goes direct when the bypass list covers the test address;
    // the main process names the proxy only when it was used.
    return t(
      String(failure).includes(" through proxy ")
        ? "settings.proxyTestFailedProxy"
        : "settings.proxyTestFailedDirect",
    );
  }
}

/** A connection test whose result is dropped if `invalidate` runs meanwhile. */
function useConnectionTest() {
  const { t } = useAppTranslation();
  const [testing, setTesting] = useState(false);
  const [failure, setFailure] = useState("");
  const run = useRef(0);
  const invalidate = useCallback(() => {
    run.current++;
    setFailure("");
  }, []);
  useEffect(
    () => () => {
      run.current++;
    },
    [],
  );
  async function start(settings: ProxySettings) {
    const current = ++run.current;
    const valid = () => current === run.current;
    setTesting(true);
    setFailure("");
    try {
      const result = await testConnection(settings, t, valid);
      if (valid()) setFailure(result);
    } finally {
      setTesting(false);
    }
  }
  return { testing, failure, start, invalidate };
}

export function NetworkProxySetting({
  networkStatus,
  onWarningSeen,
  proxy = SYSTEM,
  save,
  onSuccess,
}: {
  networkStatus?: NetworkStatus;
  onWarningSeen?: () => void;
  proxy?: ProxySettings;
  save: (patch: Partial<Settings>) => Promise<void>;
  onSuccess: (message: string) => void;
}) {
  const { t, language } = useAppTranslation();
  const [detection, setDetection] = useState<ProxyDetection>();
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const connection = useConnectionTest();
  const saving = useRef(false);
  const failing = !!(networkStatus?.proxy || networkStatus?.bypass);
  useEffect(() => {
    if (failing) onWarningSeen?.();
  }, [failing, onWarningSeen]);
  // A test result describes the settings and failures it was run against.
  const tested = `${proxy.mode}\n${proxy.url ?? ""}\n${proxy.bypass ?? ""}`;
  const { invalidate } = connection;
  useEffect(invalidate, [networkStatus?.revision, tested, invalidate]);
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

  const address =
    proxy.mode === "custom"
      ? proxy.url
      : proxy.mode === "system"
        ? detection?.system
        : undefined;
  const status =
    proxy.mode === "system" && !address
      ? !detection
        ? t("settings.proxyChecking")
        : detection.unsupported
          ? t("settings.proxyUnsupported")
          : t("settings.proxyNoSystem")
      : undefined;
  const bypass = proxy.mode === "custom" ? proxy.bypass?.trim() : undefined;

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
            {(address || bypass) && (
              <dl
                className="settings-entry-description settings-entry-details"
                id="network-proxy-details"
              >
                {address && (
                  <>
                    <dt>{t("settings.proxyAddressLabel")}</dt>
                    <dd
                      className="settings-entry-value truncate"
                      id="network-proxy-address"
                      role="status"
                    >
                      {proxy.mode === "system" ? (
                        <Hint
                          content={
                            <span className="link-target-hint">{address}</span>
                          }
                        >
                          <span className="block truncate" tabIndex={0}>
                            {address}
                          </span>
                        </Hint>
                      ) : (
                        address
                      )}
                    </dd>
                  </>
                )}
                {bypass && (
                  <>
                    <dt>{t("settings.proxyBypassLabel")}</dt>
                    <dd
                      className="settings-entry-value truncate"
                      id="network-proxy-bypass-summary"
                    >
                      {bypass}
                    </dd>
                  </>
                )}
              </dl>
            )}
            {status && (
              <ItemDescription
                className="settings-entry-description"
                id="network-proxy-status"
                role="status"
              >
                {status}
              </ItemDescription>
            )}
            {(failing || connection.failure) && (
              <SettingsConnectionWarning id="network-proxy-warning">
                <span>
                  {connection.failure ||
                    t(
                      networkStatus?.proxy && networkStatus.bypass
                        ? "settings.networkBothFailed"
                        : networkStatus?.bypass
                          ? "settings.networkBypassFailed"
                          : "settings.networkProxyFailed",
                    )}
                  {/* A custom proxy is tested from its dialog, beside Edit. */}
                  {proxy.mode !== "custom" && (
                    <Button
                      variant="link"
                      className="ml-1.5 inline h-auto border-0 p-0 align-baseline text-[length:inherit] leading-[inherit] font-medium text-inherit underline underline-offset-2"
                      disabled={connection.testing || pending}
                      onClick={() => void connection.start(proxy)}
                    >
                      {t(
                        connection.testing
                          ? "settings.proxyTesting"
                          : "settings.proxyTest",
                      )}
                    </Button>
                  )}
                </span>
              </SettingsConnectionWarning>
            )}
          </ItemContent>
          <ItemActions className="settings-entry-actions">
            {proxy.mode === "custom" && (
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => setEditing(true)}
                aria-label={t("settings.proxyEditLabel")}
                aria-describedby={
                  address || bypass ? "network-proxy-details" : undefined
                }
              >
                <Pencil data-icon="inline-start" aria-hidden="true" />
                {t("settings.proxyEdit")}
              </Button>
            )}
            <NativeSelect
              aria-label={t("settings.proxy")}
              aria-describedby={
                address || bypass
                  ? "network-proxy-details"
                  : status
                    ? "network-proxy-status"
                    : undefined
              }
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
  const { t } = useAppTranslation();
  const [source, setSource] = useState<"system" | "environment">();
  const [url, setUrl] = useState(proxy.url ?? "");
  const [bypass, setBypass] = useState(proxy.bypass ?? "");
  const [error, setError] = useState("");
  const connection = useConnectionTest();
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
      await connection.start(draft(normalized));
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
                  connection.invalidate();
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
                onChange={(event) => {
                  setBypass(event.target.value);
                  connection.invalidate();
                }}
              />
              <FieldDescription id="network-proxy-bypass-hint">
                {t("settings.proxyBypassHint")}
              </FieldDescription>
            </Field>
            {connection.failure && (
              <FieldDescription className="text-[var(--warning)]" role="alert">
                <span className="inline-flex items-start gap-1.5">
                  <CircleAlert
                    className="mt-0.5 size-3.5 shrink-0"
                    aria-hidden="true"
                  />
                  {connection.failure}
                </span>
              </FieldDescription>
            )}
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
