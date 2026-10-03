import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Network, Plus, Settings2 } from "lucide-react";
import { toast } from "@/components/ui/toast";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item";
import { useAppTranslation } from "@/i18n";
import type { Bootstrap, McpSnapshot } from "../../../../shared/contracts";
import { SearchInput } from "./SearchInput";
import { McpConnectionDialog } from "./McpConnectionDialog";
import { settingsFailure } from "./settings-notification";
import {
  mcpEndpoint,
  parseMcpImport,
  readMcpConfiguration,
  type McpConnectionConfig,
} from "./mcp-configuration";

export function McpSettings({
  data,
  onMcpChange,
  onSuccess,
}: {
  data: Bootstrap;
  onMcpChange: (snapshot: McpSnapshot) => void;
  onSuccess: (message: string) => void;
}) {
  const { t, language } = useAppTranslation();
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<{ id: string; adding: boolean }>();
  const [busy, setBusy] = useState<string>();
  const acting = useRef(false);
  const cancelRequested = useRef(false);
  const [results, setResults] = useState<
    Record<string, { config: string; tools: number }>
  >({});
  const [url, setUrl] = useState("");
  const loginId = useRef<string | undefined>(undefined);
  const reportedError = useRef<string | undefined>(undefined);
  const servers = data.mcp?.servers ?? [];
  const configuration = readMcpConfiguration(data.mcp?.config);

  const search = query.trim().toLocaleLowerCase();
  const filteredServers = servers.filter((server) =>
    `${server.name} ${mcpEndpoint(configuration.mcpServers[server.name])}`
      .toLocaleLowerCase()
      .includes(search),
  );

  useEffect(() => {
    const error = data.mcp?.error;
    if (error && error !== reportedError.current)
      toast.add(
        settingsFailure(
          t("mcp.loadFailed"),
          error,
          language,
          false,
          t("settingsFeedback.mcpUnknown"),
        ),
      );
    reportedError.current = error;
  }, [data.mcp?.error, language, t]);

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
    if (acting.current) return false;
    acting.current = true;
    cancelRequested.current = false;
    setBusy(key);
    try {
      await operation();
      if (message) onSuccess(message);
      return true;
    } catch (error) {
      const operation = key.split(":")[0];
      if (operation === "login" && cancelRequested.current) return false;
      toast.add(
        settingsFailure(
          t(
            operation === "test"
              ? "mcp.testFailed"
              : operation === "login"
                ? "mcp.loginFailed"
                : operation === "logout"
                  ? "mcp.logoutFailed"
                  : "mcp.actionFailed",
            { name: key.slice(key.indexOf(":") + 1) },
          ),
          String(error),
          language,
          false,
          t("settingsFeedback.mcpUnknown"),
        ),
      );
      return false;
    } finally {
      acting.current = false;
      setBusy(undefined);
      setUrl("");
      loginId.current = undefined;
    }
  }
  const openEditor = (id?: string) => {
    setEditing({ id: id ?? `mcp-${crypto.randomUUID()}`, adding: !id });
  };
  async function importConnections(raw: string, operationId: string) {
    return act(
      `import:${operationId}`,
      async () => {
        const next = readMcpConfiguration(data.mcp?.config);
        const imported = parseMcpImport(raw, Object.keys(next.mcpServers));
        if ("error" in imported)
          throw new Error(
            t(`mcp.${imported.error}`, { name: imported.name ?? "" }),
          );
        next.mcpServers = { ...next.mcpServers, ...imported.servers };
        onMcpChange(
          await window.worklens.invoke("mcpSave", {
            config: JSON.stringify(next),
          }),
        );
      },
      t("mcp.saved"),
    );
  }
  const clearResult = (id: string) =>
    setResults((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  async function saveConnection(
    id: string,
    connection: McpConnectionConfig,
    operationId = id,
  ) {
    let saved: McpConnectionConfig | undefined;
    await act(
      `save:${operationId}`,
      async () => {
        const next = readMcpConfiguration(data.mcp?.config);
        next.mcpServers = { ...next.mcpServers, [id]: connection };
        const snapshot = await window.worklens.invoke("mcpSave", {
          config: JSON.stringify(next),
        });
        onMcpChange(snapshot);
        saved = readMcpConfiguration(snapshot.config).mcpServers[id];
        clearResult(id);
      },
      t("mcp.saved"),
    );
    return saved;
  }
  async function removeConnection(id: string) {
    return act(
      `remove:${id}`,
      async () => {
        const next = readMcpConfiguration(data.mcp?.config);
        delete next.mcpServers[id];
        // Removing a configuration does not revoke the account's OAuth login.
        onMcpChange(
          await window.worklens.invoke("mcpSave", {
            config: JSON.stringify(next),
          }),
        );
        clearResult(id);
      },
      t("mcp.removed"),
    );
  }
  function testConnection(id: string) {
    return act(
      `test:${id}`,
      async () => {
        clearResult(id);
        const result = await window.worklens.invoke("mcpTest", { name: id });
        setResults((current) => ({
          ...current,
          [id]: {
            config: JSON.stringify(configuration.mcpServers[id]),
            tools: result.tools,
          },
        }));
      },
      t("settingsFeedback.modelConnected", { service: id }),
    );
  }
  function signIn(id: string) {
    return act(
      `login:${id}`,
      async () => {
        const login = crypto.randomUUID();
        loginId.current = login;
        await window.worklens.invoke("mcpLogin", { name: id, loginId: login });
        if (data.mcp)
          onMcpChange({
            ...data.mcp,
            servers: servers.map((server) =>
              configuration.mcpServers[server.name]?.url &&
              new URL(configuration.mcpServers[server.name].url!).href ===
                new URL(configuration.mcpServers[id].url!).href
                ? { ...server, signedIn: true }
                : server,
            ),
          });
        clearResult(id);
      },
      t("mcp.signedIn"),
    );
  }
  const resultFor = (id: string) => {
    const result = results[id];
    return result &&
      result.config === JSON.stringify(configuration.mcpServers[id])
      ? t("mcp.tested", { count: result.tools })
      : undefined;
  };
  function cancelSignIn() {
    if (!loginId.current || cancelRequested.current) return;
    cancelRequested.current = true;
    void window.worklens
      .invoke("authCancel", { loginId: loginId.current })
      .catch((error) => {
        cancelRequested.current = false;
        toast.add(
          settingsFailure(
            t("mcp.cancelFailed"),
            String(error),
            language,
            false,
            t("settingsFeedback.mcpUnknown"),
          ),
        );
      });
  }
  const loginButtons = (
    <>
      <Button variant="outline" onClick={cancelSignIn}>
        {t("common.cancel")}
      </Button>
      {url && (
        <Button
          onClick={() =>
            void window.worklens
              .invoke("external", { url })
              .catch((error) =>
                toast.add(
                  settingsFailure(
                    t("settingsFeedback.browserFailed"),
                    String(error),
                    language,
                    false,
                    t("settingsFeedback.mcpUnknown"),
                  ),
                ),
              )
          }
        >
          {t("mcp.openBrowser")}
        </Button>
      )}
    </>
  );
  const loginActions = busy?.startsWith("login:") && (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) cancelSignIn();
      }}
    >
      <DialogContent className="settings-dialog settings-disconnect-dialog">
        <DialogHeader>
          <DialogTitle>
            {t("mcp.signInTitle", { name: busy.slice("login:".length) })}
          </DialogTitle>
          <DialogDescription className="flex items-center gap-2">
            <LoaderCircle
              className="size-4 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
            {t("mcp.signingIn")}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>{loginButtons}</DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return (
    <div data-mcp-settings>
      <div className="settings-toolbar">
        <SearchInput
          value={query}
          onValueChange={setQuery}
          placeholder={t("mcp.searchPlaceholder")}
          aria-label={t("mcp.search")}
        />
      </div>
      <section className="settings-section">
        <div className="settings-mcp-heading">
          <h2 className="settings-group-bar" data-slot="settings-section-title">
            {t("common.connected")}
            <span className="settings-group-count" aria-hidden="true">
              {filteredServers.length}
            </span>
          </h2>
          {servers.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              disabled={!!busy}
              onClick={() => openEditor()}
            >
              <Plus data-icon="inline-start" aria-hidden="true" />
              {t("mcp.add")}
            </Button>
          )}
        </div>
        {servers.length === 0 ? (
          <div className="settings-list settings-mcp-empty">
            <Network
              className="size-6 text-muted-foreground"
              aria-hidden="true"
            />
            <p className="text-sm font-medium">{t("mcp.emptyTitle")}</p>
            <p className="text-sm leading-6 text-muted-foreground max-w-sm">
              {t("mcp.emptyDescription")}
            </p>
            <Button
              variant="outline"
              disabled={!!busy}
              onClick={() => openEditor()}
            >
              <Plus data-icon="inline-start" aria-hidden="true" />
              {t("mcp.add")}
            </Button>
          </div>
        ) : filteredServers.length === 0 ? (
          <p className="settings-empty">{t("mcp.noResults")}</p>
        ) : (
          <ItemGroup className="settings-list settings-connection-list">
            {filteredServers.map((server) => {
              const connection = configuration.mcpServers[server.name];
              const name = server.name;
              const result = resultFor(server.name);
              return (
                <Item
                  key={server.name}
                  role="listitem"
                  size="sm"
                  className="settings-entry"
                  data-mcp-connection={server.name}
                >
                  <ItemContent className="settings-entry-copy">
                    <ItemTitle className="settings-entry-title">
                      <Network className="size-4 shrink-0" aria-hidden="true" />
                      <span>{name}</span>
                    </ItemTitle>
                    <ItemDescription className="settings-entry-description">
                      {t(server.enabled ? "mcp.enabled" : "mcp.disabled")} ·{" "}
                      {t(
                        server.transport === "http"
                          ? "mcp.remote"
                          : "mcp.local",
                      )}
                      {mcpEndpoint(connection) && (
                        <span className="block">{mcpEndpoint(connection)}</span>
                      )}
                    </ItemDescription>
                    {result && (
                      <p
                        className="text-xs text-muted-foreground"
                        role="status"
                      >
                        {result}
                      </p>
                    )}
                  </ItemContent>
                  <ItemActions className="settings-entry-actions flex-wrap">
                    {server.oauth && !server.signedIn && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!!busy}
                        onClick={() => void signIn(server.name)}
                        aria-label={t("mcp.signInNamed", { name })}
                      >
                        {t("mcp.signIn")}
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!!busy}
                      onClick={() => openEditor(server.name)}
                      aria-label={t("mcp.manageNamed", { name })}
                    >
                      <Settings2 data-icon="inline-start" aria-hidden="true" />
                      {t("common.manage")}
                    </Button>
                  </ItemActions>
                </Item>
              );
            })}
          </ItemGroup>
        )}
        {!editing && loginActions}
      </section>
      {editing && (
        <McpConnectionDialog
          key={editing.id}
          adding={editing.adding}
          connection={configuration.mcpServers[editing.id]}
          name={editing.adding ? "" : editing.id}
          names={servers.map((server) => server.name)}
          server={servers.find((server) => server.name === editing.id)}
          busy={busy}
          result={resultFor(editing.id)}
          loginActions={loginActions}
          onSave={(connection, name) =>
            saveConnection(name, connection, editing.id)
          }
          onImport={(raw) => importConnections(raw, editing.id)}
          onRemove={() => removeConnection(editing.id)}
          onTest={() => testConnection(editing.id)}
          onSignIn={() => void signIn(editing.id)}
          onSignOut={() =>
            void act(
              `logout:${editing.id}`,
              async () => {
                onMcpChange(
                  await window.worklens.invoke("mcpLogout", {
                    name: editing.id,
                  }),
                );
                clearResult(editing.id);
              },
              t("mcp.signedOut"),
            )
          }
          onClose={() => {
            setEditing(undefined);
          }}
        />
      )}
    </div>
  );
}
