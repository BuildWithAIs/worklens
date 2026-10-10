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
import { McpConnectionStatus } from "./McpConnectionStatus";
import { mcpConnectionId } from "./mcp-presets";
import { settingsFailure } from "./settings-notification";
import {
  mcpEndpoint,
  mcpDisplayName,
  parseMcpImport,
  readMcpConfiguration,
  type McpConnectionConfig,
  type McpTestResult,
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
  // The key stays stable when a new connection receives its saved ID.
  const [editing, setEditing] = useState<{
    key: string;
    id: string;
    adding: boolean;
  }>();
  const [busy, setBusy] = useState<string>();
  const acting = useRef(false);
  const cancelRequested = useRef(false);
  const [results, setResults] = useState<
    Record<string, { config: string; result: McpTestResult }>
  >({});
  const snapshotRef = useRef(data.mcp);
  snapshotRef.current = data.mcp;
  const [url, setUrl] = useState("");
  const loginId = useRef<string | undefined>(undefined);
  const reportedError = useRef<string | undefined>(undefined);
  const servers = data.mcp?.servers ?? [];
  const configuration = readMcpConfiguration(data.mcp?.config);

  const search = query.trim().toLocaleLowerCase();
  const filteredServers = servers.filter((server) =>
    `${mcpDisplayName(server.name, configuration.mcpServers[server.name])} ${mcpEndpoint(configuration.mcpServers[server.name])}`
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
            operation === "login"
              ? "mcp.loginFailed"
              : operation === "logout"
                ? "mcp.logoutFailed"
                : "mcp.actionFailed",
            { name: connectionName(key.slice(key.indexOf(":") + 1)) },
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
    const key = id ?? `mcp-${crypto.randomUUID()}`;
    setEditing({ key, id: key, adding: !id });
  };
  function connectionName(id: string) {
    return mcpDisplayName(
      id,
      readMcpConfiguration(snapshotRef.current?.config).mcpServers[id],
    );
  }
  function acceptSnapshot(snapshot: McpSnapshot) {
    snapshotRef.current = snapshot;
    onMcpChange(snapshot);
  }
  async function verifyConnection(
    id: string,
    snapshot: McpSnapshot,
    notify = true,
  ) {
    const config = readMcpConfiguration(snapshot.config).mcpServers[id];
    const setResult = (result: McpTestResult) =>
      setResults((current) => ({
        ...current,
        [id]: { config: JSON.stringify(config), result },
      }));
    setBusy(`test:${id}`);
    setResult({ state: "testing" });
    try {
      const result = await window.worklens.invoke("mcpTest", { name: id });
      setResult({ state: "passed", tools: result.tools });
      if (notify)
        onSuccess(
          t("settingsFeedback.modelConnected", {
            service: mcpDisplayName(id, config),
          }),
        );
      return true;
    } catch (error) {
      const message = String(error);
      if (message.includes("Sign in to this MCP server first")) {
        setResult({ state: "signIn" });
      } else {
        setResult({ state: "failed", error: message });
        if (notify)
          toast.add(
            settingsFailure(
              t("mcp.testFailed", { name: mcpDisplayName(id, config) }),
              message,
              language,
              false,
              t("settingsFeedback.mcpUnknown"),
            ),
          );
      }
      return false;
    }
  }
  async function importConnections(raw: string, operationId: string) {
    let snapshot: McpSnapshot | undefined;
    let ids: string[] = [];
    const saved = await act(`import:${operationId}`, async () => {
      const next = readMcpConfiguration(snapshotRef.current?.config);
      const imported = parseMcpImport(raw, Object.keys(next.mcpServers));
      if ("error" in imported)
        throw new Error(
          t(`mcp.${imported.error}`, { name: imported.name ?? "" }),
        );
      next.mcpServers = { ...next.mcpServers, ...imported.servers };
      snapshot = await window.worklens.invoke("mcpSave", {
        config: JSON.stringify(next),
      });
      acceptSnapshot(snapshot);
      ids = Object.keys(imported.servers);
      ids.forEach(clearResult);
      ids = ids.filter((id) => imported.servers[id].enabled !== false);
    });
    if (!saved) return false;
    if (!snapshot || !ids.length) {
      onSuccess(t("mcp.imported"));
      return true;
    }
    // Close the import dialog first. Rows show each result; like built-in
    // connectors, one toast reports the outcome once testing finishes.
    void act(`test:${ids[0]}`, async () => {
      const failed = await verifyAll(ids, snapshot!);
      if (!failed) onSuccess(t("mcp.imported"));
      else
        toast.add({
          type: "error",
          timeout: 0,
          priority: "high",
          title: t("mcp.importAttention", { count: failed }),
          description: t("mcp.importAttentionDescription"),
        });
    });
    return true;
  }
  /** Tests a few connections at a time and returns how many did not pass. */
  async function verifyAll(ids: string[], snapshot: McpSnapshot) {
    const queue = [...ids];
    let failed = 0;
    const worker = async () => {
      for (let id = queue.shift(); id; id = queue.shift())
        if (!(await verifyConnection(id, snapshot, false))) failed++;
    };
    await Promise.all(Array.from({ length: Math.min(3, ids.length) }, worker));
    return failed;
  }
  const clearResult = (id: string) =>
    setResults((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  /** Connections on the same OAuth server share one sign-in. */
  function sameEndpoint(
    connections: Record<string, McpConnectionConfig>,
    a: string,
    b: string,
  ) {
    const left = connections[a]?.url;
    const right = connections[b]?.url;
    return !!left && !!right && new URL(left).href === new URL(right).href;
  }
  function clearTargetResults(id: string, snapshot: McpSnapshot) {
    const connections = readMcpConfiguration(snapshot.config).mcpServers;
    setResults((current) =>
      Object.fromEntries(
        Object.entries(current).filter(
          ([name]) => name !== id && !sameEndpoint(connections, id, name),
        ),
      ),
    );
  }
  async function saveConnection(
    id: string,
    connection: McpConnectionConfig,
    adding: boolean,
    showSaved: (saved: McpConnectionConfig) => void,
  ) {
    return act(`save:${id}`, async () => {
      const next = readMcpConfiguration(snapshotRef.current?.config);
      const stored = { ...connection };
      // Legacy names remain the fallback; store a label only when it differs.
      if (stored.displayName === id) delete stored.displayName;
      next.mcpServers = { ...next.mcpServers, [id]: stored };
      const snapshot = await window.worklens.invoke("mcpSave", {
        config: JSON.stringify(next),
      });
      acceptSnapshot(snapshot);
      clearResult(id);
      // Reset the editor to the saved, masked values before testing so the
      // draft is clean and the test status stays visible.
      showSaved(readMcpConfiguration(snapshot.config).mcpServers[id]);
      if (adding)
        setEditing((current) => current && { ...current, id, adding: false });
      let passed = true;
      if (connection.enabled === false) onSuccess(t("mcp.saved"));
      else passed = await verifyConnection(id, snapshot);
      if (adding && passed) setEditing(undefined);
    });
  }
  async function removeConnection(id: string) {
    return act(
      `remove:${id}`,
      async () => {
        const next = readMcpConfiguration(snapshotRef.current?.config);
        delete next.mcpServers[id];
        // Removing a configuration does not revoke the account's OAuth login.
        acceptSnapshot(
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
    return act(`test:${id}`, () => verifyConnection(id, snapshotRef.current!));
  }
  function signIn(id: string) {
    return act(`login:${id}`, async () => {
      const login = crypto.randomUUID();
      loginId.current = login;
      await window.worklens.invoke("mcpLogin", { name: id, loginId: login });
      loginId.current = undefined;
      const snapshot = snapshotRef.current!;
      const config = readMcpConfiguration(snapshot.config);
      clearTargetResults(id, snapshot);
      const updated = {
        ...snapshot,
        servers: snapshot.servers.map((server) =>
          sameEndpoint(config.mcpServers, id, server.name)
            ? { ...server, signedIn: true }
            : server,
        ),
      };
      acceptSnapshot(updated);
      if (config.mcpServers[id].enabled !== false)
        await verifyConnection(id, updated);
    });
  }
  const resultFor = (id: string) => {
    const result = results[id];
    return result &&
      result.config === JSON.stringify(configuration.mcpServers[id])
      ? result.result
      : { state: "untested" as const };
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
            {t("mcp.signInTitle", {
              name: connectionName(busy.slice("login:".length)),
            })}
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
            {t("mcp.connections")}
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
              const name = mcpDisplayName(server.name, connection);
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
                    {server.enabled && result.state !== "untested" && (
                      <McpConnectionStatus result={result} />
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
          key={editing.key}
          adding={editing.adding}
          connection={configuration.mcpServers[editing.id]}
          name={
            editing.adding
              ? ""
              : mcpDisplayName(editing.id, configuration.mcpServers[editing.id])
          }
          names={servers.map((server) => server.name)}
          displayNames={servers
            .filter((server) => server.name !== editing.id)
            .map((server) =>
              mcpDisplayName(
                server.name,
                configuration.mcpServers[server.name],
              ),
            )}
          server={servers.find((server) => server.name === editing.id)}
          busy={busy}
          result={resultFor(editing.id)}
          loginActions={loginActions}
          onSave={(connection, name, showSaved) => {
            const id = editing.adding
              ? mcpConnectionId(
                  name,
                  servers.map((server) => server.name),
                )
              : editing.id;
            return saveConnection(id, connection, editing.adding, showSaved);
          }}
          onImport={(raw) => importConnections(raw, editing.id)}
          onRemove={() => removeConnection(editing.id)}
          onTest={() => testConnection(editing.id)}
          onSignIn={() => void signIn(editing.id)}
          onSignOut={() =>
            void act(
              `logout:${editing.id}`,
              async () => {
                const snapshot = await window.worklens.invoke("mcpLogout", {
                  name: editing.id,
                });
                acceptSnapshot(snapshot);
                clearTargetResults(editing.id, snapshot);
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
