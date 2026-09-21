import { savedCredentialPlaceholder } from "./credential-placeholder";
import { ProviderIcon } from "./ProviderIcon";
import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { useAppTranslation } from "@/i18n";
import { systemText } from "@/lib/system-text";
import type { AuthStep, ProviderInfo } from "../../../../shared/contracts";
const api = window.worklens;
type Method = "api_key" | "oauth";
const endpointFields = [
  {
    key: "baseUrl",
    label: "provider.endpoint.baseUrl",
    placeholder: "https://example.openai.azure.com",
  },
  {
    key: "resource",
    label: "provider.endpoint.resourceName",
    placeholder: "example",
  },
  {
    key: "apiVersion",
    label: "provider.endpoint.apiVersion",
    placeholder: "2024-10-21",
  },
  {
    key: "deployments",
    label: "provider.endpoint.modelDeployment",
    placeholder: "gpt-4.1=my-deployment",
  },
] as const;
// Provider-specific capabilities supply fields; all providers share this flow.
const configuration = { "azure-openai-responses": { fields: endpointFields } };
export function ProviderDialog({
  provider,
  onClose,
  onSaved,
  onError,
  onDisconnect,
  disconnecting = false,
}: {
  onDisconnect?: (disconnect: () => Promise<void>) => void;
  disconnecting?: boolean;
  provider: ProviderInfo;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onError: (message: string, action: "login" | "save" | "browser") => void;
}) {
  const { t, language } = useAppTranslation();
  const initialMethod =
    provider.credentialType ??
    provider.methods.find((m) => m.interactive)?.type ??
    provider.methods[0]?.type ??
    "api_key";
  const [method, setMethod] = useState<Method>(initialMethod);
  const [prompt, setPrompt] = useState<AuthStep>();
  const [steps, setSteps] = useState<AuthStep[]>([]);
  const [answer, setAnswer] = useState("");
  const [active, setActive] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{
    message: string;
    action: "login" | "save" | "browser";
  }>();
  const fail = (error: unknown, action: "login" | "save" | "browser") =>
    setError({ message: String(error), action });
  useEffect(() => {
    if (error) onError(error.message, error.action);
  }, [error, onError]);
  const loginRef = useRef<string | undefined>(undefined);
  const restoredAnswer = useRef<string | undefined>(undefined);
  const [credentialSaved, setCredentialSaved] = useState(false);
  const finishingRef = useRef(false);
  const fields =
    configuration[provider.id as keyof typeof configuration]?.fields;
  const [editEndpoint, setEditEndpoint] = useState(false);
  const [endpoint, setEndpoint] = useState({
    baseUrl: "",
    resource: "",
    apiVersion: "",
    deployments: "",
  });
  const extraRef = useRef({ enabled: editEndpoint, value: endpoint });
  extraRef.current = { enabled: editEndpoint, value: endpoint };
  const selected = provider.methods.find((m) => m.type === method);
  function cancel() {
    const loginId = loginRef.current;
    loginRef.current = undefined;
    setActive(false);
    setSubmitting(false);
    setPrompt(undefined);
    setAnswer("");
    setSteps([]);
    if (loginId) void api.invoke("authCancel", { loginId }).catch(() => {});
  }
  async function finish() {
    if (fields && extraRef.current.enabled)
      await api.invoke("azure", extraRef.current.value);
    await onSaved();
  }
  async function begin(next: Method, draft?: string) {
    if (
      loginRef.current ||
      !provider.methods.find((m) => m.type === next)?.interactive
    )
      return;
    const loginId = crypto.randomUUID();
    restoredAnswer.current = draft;
    loginRef.current = loginId;
    setActive(true);
    setError(undefined);
    setAnswer(draft ?? "");
    setSteps([]);
    setPrompt(undefined);
    try {
      await api.invoke("login", { provider: provider.id, type: next, loginId });
      if (loginRef.current !== loginId) return;
      finishingRef.current = true;
      setCredentialSaved(true);
      setSubmitting(true);
      setPrompt(undefined);
      await finish();
    } catch (e) {
      if (loginRef.current === loginId)
        fail(e, finishingRef.current ? "save" : "login");
    } finally {
      if (loginRef.current === loginId) {
        loginRef.current = undefined;
        setActive(false);
        finishingRef.current = false;
        setSubmitting(false);
      }
    }
  }
  useEffect(() => {
    const unsubscribe = api.onAuth((step) => {
      if (step.loginId !== loginRef.current) return;
      if (step.type === "prompt_cancelled") {
        setPrompt((prev) =>
          prev?.promptId === step.promptId ? undefined : prev,
        );
        return;
      }
      if (step.promptId) {
        setPrompt(step);
        setAnswer(restoredAnswer.current ?? "");
        restoredAnswer.current = undefined;
      } else setSteps((prev) => [...prev.slice(-7), step]);
    });
    // API-key methods expose their actual SDK form immediately, without an
    // extra summary page. OAuth only starts after an explicit Continue.
    if (initialMethod === "api_key") void begin(initialMethod);
    return () => {
      unsubscribe();
      cancel();
    };
  }, []);
  async function disconnect() {
    const draft = answer;
    // Invalidate the local login before aborting it, so intentional cancellation
    // cannot surface as a login error while the confirmation is being saved.
    cancel();
    try {
      await api.invoke("logout", { provider: provider.id });
    } catch (error) {
      if (method === "api_key") void begin(method, draft);
      throw error;
    }
  }
  function changeMethod(next: Method) {
    cancel();
    setMethod(next);
    setError(undefined);
    setEditEndpoint(false);
    if (next === "api_key") void begin(next);
  }
  const endpointOnly =
    !!fields &&
    editEndpoint &&
    !answer.trim() &&
    (provider.credentialType === "api_key" || credentialSaved);
  async function submit() {
    if (submitting || finishingRef.current) return;
    if (endpointOnly) {
      cancel();
      setSubmitting(true);
      finishingRef.current = true;
      setError(undefined);
      try {
        await finish();
      } catch (e) {
        fail(e, "save");
      } finally {
        finishingRef.current = false;
        setSubmitting(false);
      }
      return;
    }
    if (!active) {
      void begin(method);
      return;
    }
    if (!prompt?.promptId || !answer.trim() || !loginRef.current) return;
    const loginId = loginRef.current;
    const promptId = prompt.promptId;
    setSubmitting(true);
    setError(undefined);
    try {
      await api.invoke("authReply", { loginId, promptId, value: answer });
      if (loginRef.current !== loginId) return;
      setPrompt((prev) => (prev?.promptId === promptId ? undefined : prev));
    } catch (e) {
      if (loginRef.current === loginId) fail(e, "login");
    } finally {
      if (loginRef.current === loginId && !finishingRef.current)
        setSubmitting(false);
    }
  }
  const canSubmit =
    !submitting &&
    (endpointOnly ||
      (selected?.interactive && (!active || (!!prompt && !!answer.trim()))));
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !submitting && !disconnecting) {
          cancel();
          onClose();
        }
      }}
    >
      <DialogContent className="settings-dialog" showCloseButton={!submitting}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ProviderIcon provider={provider.id} />
            {provider.name}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("provider.configureAuthentication")}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="provider-method">
                {t("provider.authentication")}
              </FieldLabel>
              {provider.methods.length > 1 ? (
                <NativeSelect
                  id="provider-method"
                  className="w-full"
                  value={method}
                  disabled={submitting}
                  onChange={(e) => changeMethod(e.target.value as Method)}
                >
                  {provider.methods.map((m) => (
                    <NativeSelectOption key={m.type} value={m.type}>
                      {m.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              ) : (
                <span className="text-sm">
                  {selected?.name ?? t("provider.systemCredentials")}
                </span>
              )}
            </Field>
            {provider.credentialType && method !== provider.credentialType && (
              <p className="settings-hint">
                {t("provider.methodReplacementHint")}
              </p>
            )}
            {!selected?.interactive && (
              <p className="settings-hint">
                {t("provider.systemCredentialsHint")}
              </p>
            )}
            {steps
              .filter((step) => step.type !== "complete")
              .map((step, i) => (
                <div className="auth-step" key={i}>
                  {step.message && <p>{systemText(step.message, language)}</p>}
                  {step.userCode && (
                    <code className="auth-device-code">{step.userCode}</code>
                  )}
                  {step.url && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() =>
                        void api
                          .invoke("external", { url: step.url! })
                          .catch((e) => fail(e, "browser"))
                      }
                    >
                      {t("provider.openBrowser")}
                    </Button>
                  )}
                </div>
              ))}
            {prompt && (
              <Field>
                <FieldLabel htmlFor="auth-answer">
                  {systemText(
                    prompt.message ?? t("provider.credential"),
                    language,
                  )}
                </FieldLabel>
                {prompt.type === "select" ? (
                  <NativeSelect
                    id="auth-answer"
                    className="w-full"
                    value={answer}
                    disabled={submitting}
                    onChange={(e) => setAnswer(e.target.value)}
                  >
                    <NativeSelectOption value="">
                      {t("provider.selectAnOption")}
                    </NativeSelectOption>
                    {prompt.options?.map((option) => (
                      <NativeSelectOption key={option.id} value={option.id}>
                        {systemText(option.label, language)}
                        {option.description
                          ? " — " + systemText(option.description, language)
                          : ""}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                ) : (
                  <Input
                    id="auth-answer"
                    key={prompt.promptId}
                    autoFocus
                    autoComplete="off"
                    type={prompt.type === "secret" ? "password" : "text"}
                    value={answer}
                    disabled={submitting}
                    onChange={(e) => setAnswer(e.target.value)}
                    placeholder={
                      prompt.type === "secret"
                        ? provider.credentialHint
                          ? savedCredentialPlaceholder
                          : method === "api_key"
                            ? t("provider.enterApiKey")
                            : prompt.placeholder
                        : prompt.placeholder
                    }
                  />
                )}
              </Field>
            )}
            {active && !prompt && (
              <p
                className="settings-hint flex items-center gap-2"
                role="status"
              >
                <LoaderCircle className="spin" size={16} />
                {t("provider.waitingForAuthenticationPlaceholder")}
              </p>
            )}
            {fields && method === "api_key" && (
              <>
                <Field orientation="horizontal">
                  <Switch
                    id="edit-endpoint"
                    checked={editEndpoint}
                    disabled={submitting}
                    onCheckedChange={setEditEndpoint}
                  />
                  <FieldLabel htmlFor="edit-endpoint">
                    {t("provider.updateEndpointSettings")}
                  </FieldLabel>
                </Field>
                {editEndpoint && (
                  <>
                    <p className="settings-hint">
                      {t("provider.endpointReplacementHint")}
                    </p>
                    {fields.map((field) => (
                      <Field key={field.key}>
                        <FieldLabel htmlFor={field.key}>
                          {t(field.label)}
                        </FieldLabel>
                        <Input
                          id={field.key}
                          value={endpoint[field.key]}
                          disabled={submitting}
                          placeholder={field.placeholder}
                          onChange={(e) =>
                            setEndpoint((prev) => ({
                              ...prev,
                              [field.key]: e.target.value,
                            }))
                          }
                        />
                      </Field>
                    ))}
                  </>
                )}
              </>
            )}
          </FieldGroup>

          <DialogFooter>
            {onDisconnect && (
              <Button
                type="button"
                variant="ghost"
                className="sm:mr-auto"
                disabled={submitting || disconnecting}
                onClick={() => onDisconnect(disconnect)}
              >
                {t("common.disconnect")}
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              disabled={submitting}
              onClick={() => {
                cancel();
                onClose();
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {submitting && <LoaderCircle className="spin" />}
              {endpointOnly ||
              (method === "api_key" && prompt?.type === "secret")
                ? t("common.save")
                : t("provider.continue")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
