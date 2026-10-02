import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useAppTranslation } from "@/i18n";
import type { Bootstrap, Settings } from "../../../../shared/contracts";

const empty = '{\n  "mcpServers": {}\n}';
export function McpSettings({
  data,
  save,
  refresh,
  onSuccess,
}: {
  data: Bootstrap;
  save: (patch: Partial<Settings>) => Promise<void>;
  refresh: () => Promise<unknown>;
  onSuccess: (message: string) => void;
}) {
  const { t } = useAppTranslation();
  const [config, setConfig] = useState(data.mcp?.config ?? empty);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState("");
  const [url, setUrl] = useState("");
  const loginId = useRef<string | undefined>(undefined);
  useEffect(() => {
    setConfig(data.mcp?.config ?? empty);
  }, [data.mcp?.config]);
  useEffect(
    () =>
      window.worklens.onAuth((step) => {
        if (step.loginId === loginId.current && step.type === "auth_url")
          setUrl(step.url ?? "");
      }),
    [],
  );
  useEffect(
    () => () => {
      if (loginId.current)
        void window.worklens
          .invoke("authCancel", { loginId: loginId.current })
          .catch(() => {});
    },
    [],
  );
  async function act(
    key: string,
    operation: () => Promise<unknown>,
    message?: string,
  ) {
    if (busy) return;
    setBusy(key);
    setError("");
    try {
      await operation();
      await refresh();
      if (message) onSuccess(message);
    } catch (failure) {
      const operation = key.split(":")[0];
      setError(
        `${t(operation === "test" ? "mcp.testFailed" : operation === "login" ? "mcp.loginFailed" : operation === "logout" ? "mcp.logoutFailed" : "mcp.actionFailed")} ${String(failure)}`,
      );
    } finally {
      setBusy(undefined);
      setUrl("");
      loginId.current = undefined;
    }
  }
  return (
    <section className="settings-section" data-mcp-settings>
      <h2 data-slot="settings-section-title" className="settings-group-bar">
        {t("mcp.title")}
      </h2>
      <div className="py-3">
        <div className="flex items-center justify-between gap-4">
          <label htmlFor="codemode-enabled" className="text-sm font-medium">
            {t("mcp.codemode")}
          </label>
          <Switch
            id="codemode-enabled"
            aria-label={t("mcp.codemode")}
            checked={data.settings.codemodeEnabled !== false}
            disabled={!!busy}
            onCheckedChange={(enabled) =>
              void act("codemode", () => save({ codemodeEnabled: enabled }))
            }
          />
        </div>
        <p className="text-sm leading-6 text-muted-foreground mt-2">
          {t("mcp.codemodeExplanation")}
        </p>
        <p className="text-sm text-muted-foreground mt-2">
          {t("mcp.codemodeDescription")}
        </p>
      </div>
      <p className="text-sm text-muted-foreground mb-3">
        {t("mcp.description")}
      </p>
      <label htmlFor="mcp-config" className="text-sm font-medium">
        {t("mcp.configuration")}
      </label>
      <textarea
        id="mcp-config"
        className="w-full min-h-56 rounded-md border bg-background p-3 font-mono text-xs my-2"
        value={config}
        spellCheck={false}
        disabled={!!busy}
        onChange={(event) => setConfig(event.target.value)}
      />
      <p className="text-sm text-muted-foreground mb-3">
        {t("mcp.credentialsHint")}
      </p>
      <Button
        variant="outline"
        disabled={!!busy || config === (data.mcp?.config ?? empty)}
        onClick={() =>
          void act(
            "save",
            () => window.worklens.invoke("mcpSave", { config }),
            t("mcp.saved"),
          )
        }
      >
        {busy === "save" ? t("mcp.saving") : t("common.save")}
      </Button>
      <p className="text-sm text-muted-foreground mt-2">
        {t("mcp.nextMessage")}
      </p>
      {(error || data.mcp?.error) && (
        <p role="alert" className="text-sm text-destructive mt-3">
          {error || data.mcp?.error}
        </p>
      )}
      <ul className="divide-y mt-4">
        {(data.mcp?.servers ?? []).map((server) => (
          <li
            key={server.name}
            className="py-3 flex flex-wrap items-center justify-between gap-3"
          >
            <div>
              <span className="text-sm font-medium">{server.name}</span>
              <p className="text-xs text-muted-foreground">
                {server.enabled ? t("mcp.enabled") : t("mcp.disabled")} ·{" "}
                {server.transport === "http" ? "HTTP" : "stdio"} ·{" "}
                {server.exposure}
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!!busy}
                onClick={() =>
                  void act(`test:${server.name}`, async () => {
                    const result = await window.worklens.invoke("mcpTest", {
                      name: server.name,
                    });
                    onSuccess(t("mcp.connected", { count: result.tools }));
                  })
                }
              >
                {busy === `test:${server.name}`
                  ? t("mcp.testing")
                  : t("mcp.test")}
              </Button>
              {server.oauth && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!!busy}
                  onClick={() =>
                    void act(
                      `login:${server.name}`,
                      () => {
                        const id = crypto.randomUUID();
                        loginId.current = id;
                        return window.worklens.invoke("mcpLogin", {
                          name: server.name,
                          loginId: id,
                        });
                      },
                      t("mcp.signedIn"),
                    )
                  }
                >
                  {t("mcp.signIn")}
                </Button>
              )}
              {server.signedIn && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!!busy}
                  onClick={() =>
                    void act(
                      `logout:${server.name}`,
                      () =>
                        window.worklens.invoke("mcpLogout", {
                          name: server.name,
                        }),
                      t("mcp.signedOut"),
                    )
                  }
                >
                  {t("mcp.signOut")}
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {busy?.startsWith("login:") && (
        <div className="flex items-center gap-2 mt-3">
          <span className="text-sm">{t("mcp.signingIn")}</span>
          {url && (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void window.worklens
                  .invoke("external", { url })
                  .catch((failure) => setError(String(failure)))
              }
            >
              {t("mcp.openBrowser")}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (loginId.current)
                void window.worklens
                  .invoke("authCancel", { loginId: loginId.current })
                  .catch((failure) => setError(String(failure)));
            }}
          >
            {t("common.cancel")}
          </Button>
        </div>
      )}
    </section>
  );
}
