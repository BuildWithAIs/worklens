import {
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type ReactNode,
} from "react";
import { ChevronDown, LoaderCircle, Network, Zap } from "lucide-react";
import { Tabs } from "@base-ui/react/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAppTranslation } from "@/i18n";
import { McpConnectionStatus } from "./McpConnectionStatus";
import { availableMcpName, mcpPresets, type McpPresetId } from "./mcp-presets";
import type { McpSnapshot } from "../../../../shared/contracts";
import {
  parseMcpImport,
  requiredMcpCredentials,
  type McpConnectionConfig,
  type McpTestResult,
} from "./mcp-configuration";

type EditorField = "name" | "url" | "command" | "options" | "token";
const SAVED = "<saved>";
const formFields = new Set([
  "displayName",
  "url",
  "command",
  "args",
  "enabled",
  "type",
]);

function credentialFields(connection?: McpConnectionConfig) {
  const authorization = Object.entries(connection?.headers ?? {}).find(
    ([key]) => key.toLowerCase() === "authorization",
  );
  const optionFields = Object.fromEntries(
    Object.entries(connection ?? {}).filter(([key]) => !formFields.has(key)),
  );
  if (authorization && connection?.headers) {
    const headers = { ...connection.headers };
    delete headers[authorization[0]];
    if (Object.keys(headers).length) optionFields.headers = headers;
    else delete optionFields.headers;
  }
  return { authorization, options: JSON.stringify(optionFields, null, 2) };
}

export function McpConnectionDialog({
  adding,
  connection,
  name: savedName,
  names,
  displayNames,
  server,
  busy,
  result,
  loginActions,
  onSave,
  onImport,
  onRemove,
  onTest,
  onSignIn,
  onSignOut,
  onClose,
}: {
  adding: boolean;
  connection?: McpConnectionConfig;
  name: string;
  names: string[];
  displayNames: string[];
  server?: McpSnapshot["servers"][number];
  busy?: string;
  result?: McpTestResult;
  loginActions: ReactNode;
  onSave: (
    config: McpConnectionConfig,
    name: string,
    showSaved: (saved: McpConnectionConfig) => void,
  ) => Promise<boolean>;
  onImport: (raw: string) => Promise<boolean>;
  onRemove: () => Promise<boolean>;
  onTest: () => Promise<boolean>;
  onSignIn: () => void;
  onSignOut: () => void;
  onClose: () => void;
}) {
  const { t } = useAppTranslation();
  const { authorization, options: initialOptions } =
    credentialFields(connection);
  const [name, setName] = useState(savedName);
  const [transport, setTransport] = useState(
    connection?.command ? "stdio" : "http",
  );
  const [url, setUrl] = useState(connection?.url ?? "");
  const [command, setCommand] = useState(connection?.command ?? "");
  const [args, setArgs] = useState(connection?.args?.join("\n") ?? "");
  const [token, setToken] = useState(authorization?.[1] ?? "");
  const [enabled, setEnabled] = useState(connection?.enabled !== false);
  const [options, setOptions] = useState(initialOptions);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [service, setService] = useState<McpPresetId | "other">("other");
  const serviceDrafts = useRef(
    new Map<
      string,
      {
        name: string;
        url: string;
        token: string;
        options: string;
      }
    >(),
  );
  const preset =
    adding && transport === "http"
      ? mcpPresets.find((item) => item.id === service)
      : undefined;
  function selectService(nextService: McpPresetId | "other") {
    serviceDrafts.current.set(service, { name, url, token, options });
    const nextPreset = mcpPresets.find((item) => item.id === nextService);
    const draft = serviceDrafts.current.get(nextService) ?? {
      name: nextPreset
        ? availableMcpName(nextPreset.id, [...names, ...displayNames])
        : "",
      url: nextPreset?.url ?? "",
      token: "",
      options: "{}",
    };
    setService(nextService);
    setName(draft.name);
    setUrl(draft.url);
    setToken(draft.token);
    setOptions(draft.options);
    setOptionsOpen(false);
    setErrors({});
  }
  const [method, setMethod] = useState("details");
  const [json, setJson] = useState("");
  const [jsonError, setJsonError] = useState("");
  const jsonInput = useRef<HTMLTextAreaElement>(null);
  const [errors, setErrors] = useState<Partial<Record<EditorField, string>>>(
    {},
  );
  const [confirming, setConfirming] = useState(false);
  const [focusError, setFocusError] = useState<{ field: EditorField }>();
  const cancelRemoval = useRef<HTMLButtonElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (focusError)
      form.current
        ?.querySelector<HTMLElement>(`#mcp-${focusError.field}`)
        ?.focus();
  }, [focusError]);
  const dirty =
    adding ||
    name !== savedName ||
    url !== (connection?.url ?? "") ||
    command !== (connection?.command ?? "") ||
    args !== (connection?.args?.join("\n") ?? "") ||
    token !== (authorization?.[1] ?? "") ||
    enabled !== (connection?.enabled !== false) ||
    options !== initialOptions;
  const savedToken = !!authorization;
  let hasProviderAuth = !!connection?.auth;
  try {
    const draft: unknown = JSON.parse(options);
    if (draft && typeof draft === "object" && !Array.isArray(draft))
      hasProviderAuth = "auth" in draft && !!draft.auth;
  } catch {
    // Keep the saved authentication layout while the JSON is incomplete.
  }
  const requiresPresetToken = preset?.id === "github" && !hasProviderAuth;
  const missing =
    !name.trim() ||
    !(transport === "http" ? url.trim() : command.trim()) ||
    (requiresPresetToken && !token.trim());
  const importing = adding && method === "json";

  function validateImport() {
    const imported = parseMcpImport(json, names);
    const message =
      "error" in imported
        ? t(`mcp.${imported.error}`, { name: imported.name ?? "" })
        : "";
    setJsonError(message);
    return !message;
  }
  async function submitImport() {
    if (!validateImport()) {
      jsonInput.current?.focus();
      return;
    }
    if (await onImport(json)) onClose();
  }

  function validate(field: EditorField) {
    let message = "";
    if (
      field === "token" &&
      requiresPresetToken &&
      !/^Bearer\s+\S+/i.test(token.trim())
    )
      message = t("mcp.githubTokenHint");
    // Typing into a masked field appends to the placeholder value.
    if (field === "token" && token !== SAVED && token.includes(SAVED))
      message = t("mcp.savedValueEdited");
    if (field === "name") {
      if (!name.trim()) message = t("mcp.nameRequired");
      else if (name.trim().length > 80) message = t("mcp.nameInvalid");
      else if (
        displayNames.some(
          (existing) =>
            existing.toLocaleLowerCase() === name.trim().toLocaleLowerCase(),
        )
      )
        message = t("mcp.nameDuplicate");
    }
    if (field === "url" && transport === "http") {
      try {
        const target = new URL(url.trim());
        if (
          target.username ||
          target.password ||
          url.trim().length > 4000 ||
          !(
            target.protocol === "https:" ||
            (target.protocol === "http:" &&
              ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname))
          )
        )
          message = t("mcp.urlInvalid");
      } catch {
        message = t("mcp.urlInvalid");
      }
    }
    if (field === "command" && transport === "stdio" && !command.trim())
      message = t("mcp.commandRequired");
    if (field === "options") {
      try {
        const parsed = JSON.parse(options);
        if (
          !parsed ||
          typeof parsed !== "object" ||
          Array.isArray(parsed) ||
          Object.keys(parsed).some((key) => formFields.has(key))
        )
          message = t("mcp.optionsInvalid");
        else if (
          transport === "http" &&
          Object.keys(parsed.headers ?? {}).some(
            (key) => key.toLowerCase() === "authorization",
          )
        )
          message = t("mcp.authorizationInOptions");
      } catch {
        message = t("mcp.optionsInvalid");
      }
    }
    setErrors((current) => ({ ...current, [field]: message }));
    if (field === "options" && message) setOptionsOpen(true);
    return !message;
  }
  const clear = (field: EditorField) =>
    setErrors((current) => ({ ...current, [field]: undefined }));
  const validationProps = (field: EditorField) => ({
    "aria-invalid": !!errors[field],
    "aria-describedby": errors[field]
      ? `mcp-${field}-error`
      : field === "options"
        ? `mcp-${field}-hint`
        : undefined,
    onBlur: (event: FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      // A new inline error can move the footer between mouse down and click.
      // Submit validates every field; Cancel and Delete must remain clickable.
      if (event.relatedTarget instanceof HTMLButtonElement) return;
      if (event.relatedTarget?.id === "mcp-service") return;
      validate(field);
    },
  });
  async function submit() {
    const fields = ["name", "url", "command", "options", "token"] as const;
    const valid = fields.map(validate);
    const firstInvalid = fields[valid.indexOf(false)];
    if (firstInvalid) {
      setFocusError({ field: firstInvalid });
      return;
    }
    const next: McpConnectionConfig = { ...JSON.parse(options), enabled };
    next.displayName = name.trim();
    if (connection?.type) next.type = connection.type;
    if (transport === "http") next.url = url.trim();
    else {
      next.command = command.trim();
      // Preserve unusual imported arguments, including empty strings and
      // embedded newlines, when this field has not been edited.
      if (args === (connection?.args?.join("\n") ?? "")) {
        if (connection?.args) next.args = connection.args;
      } else next.args = args ? args.split(/\r?\n/) : [];
    }
    if (transport === "http" && token.trim()) {
      next.headers = {
        ...next.headers,
        [authorization?.[0] ?? "Authorization"]: token.trim(),
      };
    }
    const required = requiredMcpCredentials(next, connection);
    if (required.length) {
      const authRequired = required.filter(
        (path) => path.toLowerCase() === "headers.authorization",
      );
      const optionsRequired = required.filter(
        (path) => !authRequired.includes(path),
      );
      setErrors({
        token: authRequired.length ? t("mcp.authorizationRequired") : undefined,
        options: optionsRequired.length
          ? t("mcp.credentialsRequired", { fields: optionsRequired.join(", ") })
          : undefined,
      });
      if (optionsRequired.length) setOptionsOpen(true);
      setFocusError({ field: authRequired.length ? "token" : "options" });
      return;
    }
    const displayName = name.trim();
    await onSave(next, displayName, (saved) => {
      // Use the saved, masked snapshot so testing is immediately available,
      // including when only a credential changed and its mask stayed the same.
      const savedFields = credentialFields(saved);
      setName(saved.displayName ?? displayName);
      setUrl(saved.url ?? "");
      setCommand(saved.command ?? "");
      setArgs(saved.args?.join("\n") ?? "");
      setEnabled(saved.enabled !== false);
      setToken(savedFields.authorization?.[1] ?? "");
      setOptions(savedFields.options);
    });
  }

  const connectionForm = (
    <form
      ref={form}
      id="mcp-connection-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <fieldset disabled={!!busy} className="flex flex-col gap-4">
        <Field data-invalid={!!errors.name}>
          <FieldLabel htmlFor="mcp-name">{t("mcp.name")}</FieldLabel>
          <Input
            ref={nameInput}
            id="mcp-name"
            value={name}
            maxLength={80}
            autoComplete="off"
            {...validationProps("name")}
            onChange={(event) => {
              setName(event.target.value);
              clear("name");
            }}
          />
          <FieldError id="mcp-name-error">{errors.name}</FieldError>
        </Field>
        <Field>
          <FieldLabel htmlFor="mcp-transport">
            {t("mcp.connectionType")}
          </FieldLabel>
          <NativeSelect
            id="mcp-transport"
            value={transport}
            disabled={!adding || !!busy}
            onChange={(event) => {
              if (service !== "other") selectService("other");
              setTransport(event.target.value);
              setErrors({});
            }}
          >
            <NativeSelectOption value="http">
              {t("mcp.remote")}
            </NativeSelectOption>
            <NativeSelectOption value="stdio">
              {t("mcp.local")}
            </NativeSelectOption>
          </NativeSelect>
        </Field>
        {transport === "http" ? (
          <>
            {adding && (
              <Field>
                <FieldLabel htmlFor="mcp-service">
                  {t("mcp.service")}
                </FieldLabel>
                <NativeSelect
                  id="mcp-service"
                  value={service}
                  onChange={(event) =>
                    selectService(event.target.value as McpPresetId | "other")
                  }
                >
                  {mcpPresets.map((item) => (
                    <NativeSelectOption key={item.id} value={item.id}>
                      {t(`mcp.services.${item.id}`)}
                    </NativeSelectOption>
                  ))}
                  <NativeSelectOption value="other">
                    {t("mcp.otherService")}
                  </NativeSelectOption>
                </NativeSelect>
              </Field>
            )}
            <Field data-invalid={!!errors.url}>
              <FieldLabel htmlFor="mcp-url">{t("mcp.url")}</FieldLabel>
              <Input
                id="mcp-url"
                value={url}
                autoComplete="off"
                {...validationProps("url")}
                onChange={(event) => {
                  setUrl(event.target.value);
                  clear("url");
                }}
                placeholder="https://example.com/mcp"
              />
              <FieldError id="mcp-url-error">{errors.url}</FieldError>
            </Field>
            {(!hasProviderAuth || savedToken || !!token) && (
              <Field data-invalid={!!errors.token}>
                <FieldLabel htmlFor="mcp-token">
                  {t(requiresPresetToken ? "mcp.tokenRequired" : "mcp.token")}
                </FieldLabel>
                <Input
                  id="mcp-token"
                  type="password"
                  value={token}
                  autoComplete="new-password"
                  aria-invalid={!!errors.token}
                  aria-describedby={
                    errors.token ? "mcp-token-error" : "mcp-token-hint"
                  }
                  placeholder="Bearer …"
                  onFocus={(event) => {
                    if (token === SAVED) event.currentTarget.select();
                  }}
                  onChange={(event) => {
                    setToken(event.target.value);
                    clear("token");
                  }}
                />
                {!errors.token && (
                  <FieldDescription id="mcp-token-hint">
                    {t(
                      savedToken
                        ? "mcp.tokenKeep"
                        : preset?.id === "github"
                          ? "mcp.githubTokenHint"
                          : "mcp.tokenHint",
                    )}
                  </FieldDescription>
                )}
                <FieldError id="mcp-token-error">{errors.token}</FieldError>
              </Field>
            )}
          </>
        ) : (
          <>
            <Field data-invalid={!!errors.command}>
              <FieldLabel htmlFor="mcp-command">{t("mcp.command")}</FieldLabel>
              <Input
                id="mcp-command"
                value={command}
                autoComplete="off"
                {...validationProps("command")}
                onChange={(event) => {
                  setCommand(event.target.value);
                  clear("command");
                }}
                placeholder="npx"
              />
              <FieldError id="mcp-command-error">{errors.command}</FieldError>
            </Field>
            <Field>
              <FieldLabel htmlFor="mcp-args">{t("mcp.arguments")}</FieldLabel>
              <Textarea
                id="mcp-args"
                value={args}
                spellCheck={false}
                className="font-mono text-xs min-h-20 max-h-40 overflow-auto"
                aria-describedby="mcp-args-hint"
                onChange={(event) => setArgs(event.target.value)}
              />
              <FieldDescription id="mcp-args-hint">
                {t("mcp.argumentsHint")}
              </FieldDescription>
            </Field>
          </>
        )}
        <div className="flex items-center justify-between gap-4">
          <label htmlFor="mcp-enabled" className="text-sm">
            {t("mcp.useConnection")}
          </label>
          <Switch
            id="mcp-enabled"
            checked={enabled}
            aria-label={t("mcp.useConnection")}
            onCheckedChange={setEnabled}
          />
        </div>
        <details
          className="settings-mcp-options"
          open={optionsOpen}
          onToggle={(event) => setOptionsOpen(event.currentTarget.open)}
        >
          <summary className="settings-mcp-disclosure">
            <ChevronDown className="size-4" aria-hidden="true" />
            {t("mcp.additionalOptions")}
          </summary>
          <Field className="pt-3" data-invalid={!!errors.options}>
            <FieldLabel htmlFor="mcp-options">{t("mcp.options")}</FieldLabel>
            <Textarea
              id="mcp-options"
              value={options}
              spellCheck={false}
              rows={4}
              className="font-mono text-xs min-h-24 max-h-64 overflow-auto"
              {...validationProps("options")}
              onChange={(event) => {
                setOptions(event.target.value);
                clear("options");
              }}
            />
            {!errors.options && (
              <FieldDescription id="mcp-options-hint">
                {t("mcp.optionsHint")}
              </FieldDescription>
            )}
            {!adding && !errors.options && options.includes('"<saved>"') && (
              <FieldDescription>{t("mcp.credentialsHint")}</FieldDescription>
            )}
            <FieldError id="mcp-options-error">{errors.options}</FieldError>
          </Field>
        </details>
      </fieldset>
    </form>
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        className="settings-dialog settings-mcp-dialog"
        initialFocus={adding ? nameInput : undefined}
        aria-busy={!!busy}
        showCloseButton={!busy}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Network className="size-4 shrink-0" aria-hidden="true" />
            {adding ? t("mcp.add") : t("mcp.manageNamed", { name: savedName })}
          </DialogTitle>
          <DialogDescription>
            {t(adding ? "mcp.addDescription" : "mcp.editorDescription")}
          </DialogDescription>
        </DialogHeader>
        {adding ? (
          <Tabs.Root
            value={method}
            onValueChange={setMethod}
            className="flex flex-col gap-4"
          >
            <Tabs.List
              className="settings-tabs"
              aria-label={t("mcp.setupMethod")}
              activateOnFocus
            >
              <Tabs.Tab
                value="details"
                disabled={!!busy}
                render={<Button variant="ghost" size="sm" />}
              >
                {t("mcp.details")}
              </Tabs.Tab>
              <Tabs.Tab
                value="json"
                disabled={!!busy}
                render={<Button variant="ghost" size="sm" />}
              >
                {t("mcp.json")}
              </Tabs.Tab>
            </Tabs.List>
            <Tabs.Panel value="details">{connectionForm}</Tabs.Panel>
            <Tabs.Panel value="json">
              <form
                id="mcp-import-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitImport();
                }}
              >
                <Field data-invalid={!!jsonError}>
                  <FieldLabel htmlFor="mcp-import">
                    {t("mcp.configuration")}
                  </FieldLabel>
                  <FieldDescription id="mcp-import-hint">
                    {t("mcp.importHint")}
                  </FieldDescription>
                  <Textarea
                    ref={jsonInput}
                    id="mcp-import"
                    value={json}
                    spellCheck={false}
                    disabled={!!busy}
                    className="font-mono text-xs min-h-64 max-h-96 overflow-auto"
                    placeholder={t("mcp.configurationPlaceholder")}
                    aria-invalid={!!jsonError}
                    aria-describedby={`mcp-import-hint${jsonError ? " mcp-import-error" : ""}`}
                    onBlur={(event) => {
                      if (
                        json.trim() &&
                        !(event.relatedTarget instanceof HTMLButtonElement)
                      )
                        validateImport();
                    }}
                    onChange={(event) => {
                      setJson(event.target.value);
                      setJsonError("");
                    }}
                  />
                  <FieldError id="mcp-import-error">{jsonError}</FieldError>
                </Field>
              </form>
            </Tabs.Panel>
          </Tabs.Root>
        ) : (
          connectionForm
        )}
        {!adding && (server?.oauth || server?.signedIn) && (
          <div className="flex flex-wrap gap-2">
            {server.oauth && !server.signedIn && (
              <Button
                variant="outline"
                size="sm"
                disabled={!!busy || dirty}
                onClick={onSignIn}
              >
                {t("mcp.signIn")}
              </Button>
            )}
            {server.signedIn && (
              <Button
                variant="outline"
                size="sm"
                disabled={!!busy || dirty}
                onClick={onSignOut}
              >
                {busy?.startsWith("logout:") && (
                  <LoaderCircle
                    className="animate-spin motion-reduce:animate-none"
                    data-icon="inline-start"
                    aria-hidden="true"
                  />
                )}
                {t("mcp.signOut")}
              </Button>
            )}
          </div>
        )}
        {loginActions}
        {result && !dirty && <McpConnectionStatus result={result} />}
        <p className="text-xs leading-5 text-muted-foreground">
          {t(!adding && dirty ? "mcp.saveBeforeTesting" : "mcp.nextMessage")}
        </p>
        <DialogFooter>
          {!adding && (
            <Button
              variant="ghost"
              className="sm:mr-auto"
              disabled={!!busy}
              onClick={() => setConfirming(true)}
            >
              {t("common.delete")}
            </Button>
          )}
          <Button variant="outline" disabled={!!busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          {!adding && (
            <Button
              variant="outline"
              disabled={!!busy || dirty}
              onClick={() => void onTest()}
            >
              {busy?.startsWith("test:") ? (
                <LoaderCircle
                  className="animate-spin motion-reduce:animate-none"
                  data-icon="inline-start"
                  aria-hidden="true"
                />
              ) : (
                <Zap data-icon="inline-start" aria-hidden="true" />
              )}
              {t(busy?.startsWith("test:") ? "mcp.testing" : "mcp.test")}
            </Button>
          )}
          <Button
            type="submit"
            form={importing ? "mcp-import-form" : "mcp-connection-form"}
            disabled={!!busy || (importing ? !json.trim() : missing || !dirty)}
          >
            {(busy?.startsWith("save:") || busy?.startsWith("import:")) && (
              <LoaderCircle
                className="animate-spin motion-reduce:animate-none"
                data-icon="inline-start"
                aria-hidden="true"
              />
            )}
            {t(
              importing
                ? busy?.startsWith("import:")
                  ? "mcp.importing"
                  : "mcp.import"
                : busy?.startsWith("save:")
                  ? "mcp.saving"
                  : adding
                    ? "mcp.add"
                    : "common.save",
            )}
          </Button>
        </DialogFooter>
        <Dialog
          open={confirming}
          onOpenChange={(open) => {
            if (!busy) setConfirming(open);
          }}
        >
          <DialogContent
            className="settings-dialog settings-disconnect-dialog"
            initialFocus={cancelRemoval}
            showCloseButton={!busy}
            aria-busy={!!busy}
          >
            <DialogHeader>
              <DialogTitle>
                {t("mcp.deleteTitle", { name: savedName })}
              </DialogTitle>
              <DialogDescription>
                {t("mcp.deleteDescription")}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                ref={cancelRemoval}
                variant="outline"
                disabled={!!busy}
                onClick={() => setConfirming(false)}
              >
                {t("common.cancel")}
              </Button>
              <Button
                variant="destructive"
                disabled={!!busy}
                onClick={() =>
                  void onRemove().then((removed) => {
                    if (removed) onClose();
                  })
                }
              >
                {busy?.startsWith("remove:") && (
                  <LoaderCircle
                    className="animate-spin motion-reduce:animate-none"
                    data-icon="inline-start"
                    aria-hidden="true"
                  />
                )}
                {t(
                  busy?.startsWith("remove:")
                    ? "mcp.removing"
                    : "common.delete",
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  );
}
