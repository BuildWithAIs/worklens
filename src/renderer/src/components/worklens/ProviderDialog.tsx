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
import { useLocale } from "@/lib/locale";
import { systemText } from "@/lib/system-text";
import type { AuthStep, ProviderInfo } from "../../../../shared/contracts";
const api = window.worklens;
type Method = "api_key" | "oauth";
const endpointFields = [
  {
    key: "baseUrl",
    en: "Base URL",
    zh: "基础地址",
    placeholder: "https://example.openai.azure.com",
  },
  {
    key: "resource",
    en: "Resource name",
    zh: "资源名",
    placeholder: "example",
  },
  {
    key: "apiVersion",
    en: "API version",
    zh: "接口版本",
    placeholder: "2024-10-21",
  },
  {
    key: "deployments",
    en: "Model = deployment",
    zh: "模型 = 部署名",
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
}: {
  provider: ProviderInfo;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const { t, language } = useLocale();
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
  const [error, setError] = useState("");
  useEffect(() => {
    if (error) onError(error);
  }, [error, onError]);
  const loginRef = useRef<string | undefined>(undefined);
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
  async function begin(next: Method) {
    if (
      loginRef.current ||
      !provider.methods.find((m) => m.type === next)?.interactive
    )
      return;
    const loginId = crypto.randomUUID();
    loginRef.current = loginId;
    setActive(true);
    setError("");
    setAnswer("");
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
        setError(systemText(String(e).replace(/^Error: /, ""), language));
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
        setAnswer("");
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
  function changeMethod(next: Method) {
    cancel();
    setMethod(next);
    setError("");
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
      setError("");
      try {
        await finish();
      } catch (e) {
        setError(systemText(String(e), language));
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
    setError("");
    try {
      await api.invoke("authReply", { loginId, promptId, value: answer });
      if (loginRef.current !== loginId) return;
      setPrompt((prev) => (prev?.promptId === promptId ? undefined : prev));
    } catch (e) {
      if (loginRef.current === loginId)
        setError(systemText(String(e), language));
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
        if (!open && !submitting) {
          cancel();
          onClose();
        }
      }}
    >
      <DialogContent className="settings-dialog" showCloseButton={!submitting}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><ProviderIcon provider={provider.id} />{provider.name}</DialogTitle>
          <DialogDescription className="sr-only">
            {t("Configure authentication", "配置认证")}
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
                {t("Authentication", "认证方式")}
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
                  {selected?.name ?? t("System credentials", "系统凭据")}
                </span>
              )}
            </Field>
            {provider.credentialType && method !== provider.credentialType && (
              <p className="settings-hint">
                {t(
                  "Replaces the current method after successful sign-in.",
                  "登录成功后替换当前认证方式。",
                )}
              </p>
            )}
            {!selected?.interactive && (
              <p className="settings-hint">
                {t(
                  "Managed through your system environment.",
                  "通过系统环境配置。",
                )}
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
                          .catch((e) =>
                            setError(systemText(String(e), language)),
                          )
                      }
                    >
                      {t("Open browser", "打开浏览器")}
                    </Button>
                  )}
                </div>
              ))}
            {prompt && (
              <Field>
                <FieldLabel htmlFor="auth-answer">
                  {systemText(
                    prompt.message ?? t("Credential", "凭据"),
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
                      {t("Select an option", "请选择")}
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
                        ? (provider.credentialHint ?? "••••••••")
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
                {t("Waiting for authentication…", "等待认证…")}
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
                    {t("Update endpoint settings", "更新端点设置")}
                  </FieldLabel>
                </Field>
                {editEndpoint && (
                  <>
                    <p className="settings-hint">
                      {t(
                        "Replaces endpoint settings. Blank fields are cleared.",
                        "替换端点配置，空白字段会被清除。",
                      )}
                    </p>
                    {fields.map((field) => (
                      <Field key={field.key}>
                        <FieldLabel htmlFor={field.key}>
                          {t(field.en, field.zh)}
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
          {error && (
            <p role="alert" className="model-test-result failed">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={submitting}
              onClick={() => {
                cancel();
                onClose();
              }}
            >
              {t("Cancel", "取消")}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {submitting && <LoaderCircle className="spin" />}
              {endpointOnly ||
              (method === "api_key" && prompt?.type === "secret")
                ? t("Save", "保存")
                : t("Continue", "继续")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
