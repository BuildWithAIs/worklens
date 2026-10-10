import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import {
  createMcpExtension,
  type McpExtensionOptions,
  type McpServerConfig,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import {
  McpClient,
  StdioTransport,
  StreamableHttpTransport,
  type AuthProvider,
  type McpTransport,
} from "@earendil-works/pi-mcp";
import {
  adaptOAuthProvider,
  authorizeMcp,
  McpOAuthProvider,
  OAuthCallbackServer,
  type McpOAuthState,
} from "@earendil-works/pi-mcp/oauth";
import { SerialQueue, redactStrings, type Encryption } from "./storage";
import type { AuthStep, McpSnapshot } from "../shared/contracts";

const SAVED = "<saved>";
const stringMap = z.record(z.string().min(1).max(200), z.string().max(20000));
const exposure = z.enum(["direct", "deferred", "codemode", "hidden"]);
const common = {
  description: z.string().max(4000).optional(),
  enabled: z.boolean().optional(),
  exposure: exposure.optional(),
  toolExposure: z.record(z.string().max(200), exposure).optional(),
  timeout: z.number().positive().max(3600).optional(),
};
const httpUrl = z
  .string()
  .url()
  .max(4000)
  .refine((value) => {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    );
  }, "Use HTTPS, or HTTP on a loopback host");
const configSchema = z
  .object({
    mcpServers: z
      .record(
        z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
        z.union([
          z
            .object({
              ...common,
              type: z.literal("stdio").optional(),
              command: z.string().trim().min(1).max(4000),
              args: z.array(z.string().max(20000)).max(200).optional(),
              cwd: z.string().max(4000).optional(),
              env: stringMap.optional(),
            })
            .strict(),
          z
            .object({
              ...common,
              type: z.enum(["http", "streamable-http"]).optional(),
              url: httpUrl,
              headers: stringMap.optional(),
              auth: z
                .object({ provider: z.string().min(1).max(200) })
                .strict()
                .optional(),
              oauth: z
                .object({
                  clientId: z.string().max(4000).optional(),
                  clientSecret: z.string().max(20000).optional(),
                  callbackPort: z.number().int().min(1).max(65535).optional(),
                  callbackUrl: z
                    .string()
                    .url()
                    .refine((value) => {
                      const url = new URL(value);
                      return (
                        url.protocol === "http:" &&
                        ["localhost", "127.0.0.1", "[::1]"].includes(
                          url.hostname,
                        ) &&
                        !url.username &&
                        !url.password
                      );
                    })
                    .optional(),
                  scope: z.string().max(4000).optional(),
                  clientName: z.string().max(200).optional(),
                })
                .strict()
                .optional(),
            })
            .strict(),
        ]),
      )
      .refine((servers) => Object.keys(servers).length <= 100),
  })
  .strict()
  .superRefine((value, ctx) => {
    const names = Object.keys(value.mcpServers).map((name) =>
      name.replaceAll("-", "_"),
    );
    if (new Set(names).size !== names.length)
      ctx.addIssue({
        code: "custom",
        message: "Server names must have distinct tool namespaces",
      });
  });
type Config = { mcpServers: Record<string, McpServerConfig> };

/** Entire documents are encrypted, including embedded headers, env values and OAuth state. */
export class EncryptedDocument<T> {
  constructor(
    private path: string,
    private encryption: Encryption,
    private fallback: T,
  ) {}
  read(): T {
    try {
      const data = JSON.parse(readFileSync(this.path, "utf8"));
      if (data.version !== 1 || typeof data.encrypted !== "string")
        throw new Error("Unreadable MCP storage");
      return JSON.parse(
        this.encryption.decryptString(Buffer.from(data.encrypted, "base64")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return structuredClone(this.fallback);
      throw new Error(
        "Couldn’t read saved MCP settings. Check secure storage.",
      );
    }
  }
  write(value: T) {
    if (!this.encryption.isEncryptionAvailable())
      throw new Error("Secure storage is unavailable");
    mkdirSync(dirname(this.path), { recursive: true });
    const path = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        encrypted: this.encryption
          .encryptString(JSON.stringify(value))
          .toString("base64"),
      }),
      { mode: 0o600 },
    );
    renameSync(path, this.path);
  }
}

/** Pi's option is a concrete class with private fields; the adapter implements its public contract. */
export class McpCredentials implements Pick<
  NonNullable<McpExtensionOptions["credentials"]>,
  "forServer" | "tokens" | "remove"
> {
  private queue = new SerialQueue();
  constructor(
    private document: EncryptedDocument<Record<string, McpOAuthState>>,
    private remember: (value: unknown) => void,
  ) {}
  forServer(url: string) {
    const key = new URL(url).href;
    return {
      load: () => {
        const state = this.document.read()[key];
        this.remember(state);
        return state;
      },
      save: (state: McpOAuthState) => {
        const data = this.document.read();
        data[key] = state;
        this.remember(state);
        this.document.write(data);
      },
      withRefreshLock: <T>(fn: () => Promise<T>) => this.queue.run(key, fn),
    };
  }
  tokens(url: string) {
    return this.forServer(url).load()?.tokens;
  }
  remove(url: string) {
    const data = this.document.read();
    const key = new URL(url).href;
    if (!Object.hasOwn(data, key)) return false;
    delete data[key];
    this.document.write(data);
    return true;
  }
}

export class McpService {
  private config: Config = { mcpServers: {} };
  private configDocument: EncryptedDocument<Config>;
  readonly credentials: McpCredentials;
  private secrets = new Set<string>();
  private logins = new Map<
    string,
    { controller: AbortController; url: string }
  >();
  private transports = new Set<McpTransport>();
  private revision = 0;
  private stopping = false;
  private error?: string;
  constructor(
    readonly directory: string,
    encryption: Encryption,
    private emit: (step: AuthStep) => void = () => {},
    private openUrl: (url: string) => Promise<unknown> = async () => {},
  ) {
    this.configDocument = new EncryptedDocument(
      join(directory, "mcp-settings.json"),
      encryption,
      this.config,
    );
    this.credentials = new McpCredentials(
      new EncryptedDocument(
        join(directory, "mcp-credentials.json"),
        encryption,
        {},
      ),
      (value) => {
        const state = value as McpOAuthState | undefined;
        this.remember(state?.tokens?.access_token, true);
        this.remember(state?.tokens?.refresh_token, true);
        this.remember(state?.codeVerifier, true);
        if (
          state?.clientInformation &&
          "client_secret" in state.clientInformation
        )
          this.remember(state.clientInformation.client_secret, true);
      },
    );
  }
  initialize() {
    try {
      this.config = configSchema.parse(this.configDocument.read()) as Config;
      this.rememberConfig();
    } catch (error) {
      this.error = String(error);
    }
  }
  private remember(value: unknown, force = false) {
    if (
      typeof value === "string" &&
      value.length &&
      (force || value.length >= 6)
    )
      this.secrets.add(value);
    else if (value && typeof value === "object")
      Object.values(value).forEach((item) => this.remember(item));
  }
  private rememberConfig() {
    const values = (input?: Record<string, string>) => {
      for (const [key, value] of Object.entries(input ?? {})) {
        if (/\$\{[A-Z_][A-Z0-9_]*\}/.test(value)) continue;
        this.remember(
          value,
          /key|token|secret|password|credential|authorization/i.test(key),
        );
        if (key.toLowerCase() === "authorization")
          this.remember(value.replace(/^(?:Bearer|Basic)\s+/i, ""), true);
      }
    };
    for (const config of Object.values(this.config.mcpServers)) {
      if ("url" in config) {
        values(config.headers);
        if (
          config.oauth?.clientSecret &&
          !config.oauth.clientSecret.includes("${")
        )
          this.remember(config.oauth.clientSecret, true);
      } else values(config.env);
    }
  }
  redact(text: string) {
    const forms = [...this.secrets].flatMap((secret) => [
      secret,
      JSON.stringify(secret).slice(1, -1),
    ]);
    for (const secret of forms.sort((a, b) => b.length - a.length))
      text = text.split(secret).join("[redacted]");
    return text;
  }
  configurationKey() {
    return String(this.revision);
  }
  snapshot(): McpSnapshot {
    const sanitized = structuredClone(this.config);
    const mask = (values?: Record<string, string>) => {
      if (values)
        for (const key of Object.keys(values))
          if (!/^\$\{[A-Z_][A-Z0-9_]*\}$/.test(values[key]))
            values[key] = SAVED;
    };
    for (const config of Object.values(sanitized.mcpServers)) {
      if ("url" in config) {
        mask(config.headers);
        if (config.oauth?.clientSecret) config.oauth.clientSecret = SAVED;
      } else mask(config.env);
    }
    return {
      config: JSON.stringify(sanitized, null, 2),
      servers: Object.entries(this.config.mcpServers).map(([name, config]) => {
        let signedIn = false;
        if ("url" in config)
          try {
            signedIn = !!this.credentials.tokens(config.url);
          } catch (error) {
            this.error = String(error);
          }
        return {
          name,
          transport: "url" in config ? ("http" as const) : ("stdio" as const),
          enabled: config.enabled !== false,
          exposure: config.exposure ?? "codemode",
          oauth:
            "url" in config &&
            !config.auth &&
            !Object.keys(config.headers ?? {}).some(
              (key) => key.toLowerCase() === "authorization",
            ),
          signedIn,
        };
      }),
      error: this.error && this.redact(this.error),
    };
  }
  save(raw: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Enter valid MCP JSON");
    }
    const next = configSchema.safeParse(parsed);
    if (!next.success)
      throw new Error(
        "Invalid MCP configuration. Check server names, transports and fields.",
      );
    const config = next.data as Config;
    for (const [name, entry] of Object.entries(config.mcpServers)) {
      const old = this.config.mcpServers[name];
      const sameTarget =
        old &&
        ("url" in entry
          ? "url" in old && new URL(old.url).href === new URL(entry.url).href
          : !("url" in old) &&
            JSON.stringify([old.command, old.args, old.cwd]) ===
              JSON.stringify([entry.command, entry.args, entry.cwd]));
      const restore = (
        values?: Record<string, string>,
        previous?: Record<string, string>,
      ) => {
        for (const [key, value] of Object.entries(values ?? {}))
          if (value === SAVED) {
            if (!sameTarget || !previous || !Object.hasOwn(previous, key))
              throw new Error("Re-enter credentials after changing the server");
            values![key] = previous[key];
          }
      };
      if ("url" in entry) {
        restore(entry.headers, old && "url" in old ? old.headers : undefined);
        if (entry.oauth?.clientSecret === SAVED) {
          if (
            !sameTarget ||
            !old ||
            !("url" in old) ||
            !old.oauth?.clientSecret ||
            old.oauth.clientId !== entry.oauth.clientId
          )
            throw new Error("Re-enter the OAuth client secret");
          entry.oauth.clientSecret = old.oauth.clientSecret;
        }
      } else restore(entry.env, old && !("url" in old) ? old.env : undefined);
    }
    this.configDocument.write(config);
    this.cancelLogins();
    this.config = config;
    this.rememberConfig();
    this.error = undefined;
    this.revision++;
    return this.snapshot();
  }
  private expand(value: string) {
    if (value === "~") return homedir();
    return /^~[\\/]/.test(value) ? join(homedir(), value.slice(2)) : value;
  }
  private resolveValue(value: string, sensitive = false) {
    if (value.startsWith("!"))
      throw new Error(
        "Use an environment reference instead of a command for MCP credentials",
      );
    return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_match, key: string) => {
      const resolved = process.env[key];
      if (resolved === undefined)
        throw new Error(`Missing environment variable: ${key}`);
      this.remember(resolved, sensitive);
      return resolved;
    });
  }
  private transport(
    config: McpServerConfig,
    cwd: string,
    authProvider?: AuthProvider,
  ): McpTransport {
    if (this.stopping) throw new Error("MCP is shutting down");
    const values = (input?: Record<string, string>) =>
      Object.fromEntries(
        Object.entries(input ?? {}).map(([key, value]) => {
          const sensitive =
            /key|token|secret|password|credential|authorization/i.test(key);
          const resolved = this.resolveValue(value, sensitive);
          this.remember(resolved, sensitive);
          if (key.toLowerCase() === "authorization")
            this.remember(resolved.replace(/^(?:Bearer|Basic)\s+/i, ""), true);
          return [key, resolved];
        }),
      );
    const transport =
      "url" in config
        ? new StreamableHttpTransport({
            url: config.url,
            headers: values(config.headers),
            authProvider,
          })
        : new StdioTransport({
            command: this.expand(config.command),
            args: config.args?.map((value) => this.expand(value)),
            cwd: resolve(cwd, this.expand(config.cwd ?? ".")),
            env: values(config.env),
            stderr: "pipe",
          });
    this.transports.add(transport);
    return {
      start: () => transport.start(),
      send: (message) => transport.send(message),
      close: async () => {
        try {
          await transport.close();
        } finally {
          this.transports.delete(transport);
        }
      },
      onMessage: (listener) =>
        transport.onMessage((message) => {
          if ("method" in message && message.method === "notifications/message")
            listener(redactStrings(message, (text) => this.redact(text)));
          else listener(message);
        }),
      onError: (listener) =>
        transport.onError((error) =>
          listener(new Error(this.redact(error.message))),
        ),
      onClose: (listener) => transport.onClose(listener),
      setProtocolVersion: (version) => {
        if (transport instanceof StreamableHttpTransport)
          transport.setProtocolVersion(version);
      },
    };
  }
  extension(codemode: boolean) {
    return createMcpExtension({
      loadConfig: () => {
        const errors = this.error ? [this.redact(this.error)] : [];
        const servers = Object.entries(this.config.mcpServers).flatMap(
          ([name, raw]) => {
            const config = structuredClone(raw);
            if (
              config.enabled !== false &&
              "url" in config &&
              config.oauth?.clientSecret
            ) {
              try {
                config.oauth.clientSecret = this.resolveValue(
                  config.oauth.clientSecret,
                  true,
                );
              } catch (error) {
                errors.push(this.redact(`${name}: ${String(error)}`));
                return [];
              }
            }
            if (!codemode) {
              if (!config.exposure || config.exposure === "codemode")
                config.exposure = "deferred";
              for (const key of Object.keys(config.toolExposure ?? {}))
                if (config.toolExposure![key] === "codemode")
                  config.toolExposure![key] = "deferred";
            }
            return [
              {
                name,
                config,
                source: join(this.directory, "mcp-settings.json"),
                scope: "global" as const,
              },
            ];
          },
        );
        return { servers, autoEnableCodemode: codemode, errors };
      },
      credentials: this
        .credentials as unknown as McpExtensionOptions["credentials"],
      createTransport: (entry, cwd, auth) =>
        this.transport(entry.config, cwd, auth),
      logPath: process.platform === "win32" ? "NUL" : "/dev/null",
      openUrl: (url) => {
        void this.openUrl(url).catch(() => {});
      },
      updateConfig: (entry, patch) => {
        const config = structuredClone(this.config);
        config.mcpServers[entry.name] = {
          ...config.mcpServers[entry.name],
          ...patch,
        };
        this.save(JSON.stringify(config));
      },
    });
  }
  private server(name: string) {
    if (!Object.hasOwn(this.config.mcpServers, name))
      throw new Error("Unknown MCP server");
    const config = this.config.mcpServers[name];
    if (!config) throw new Error("Unknown MCP server");
    return config;
  }
  async test(name: string, cwd: string, runtime: ModelRuntime) {
    const config = this.server(name);
    let auth: AuthProvider | undefined;
    let headers: Record<string, string> | undefined;
    if ("url" in config) {
      if (config.auth) {
        const token = (await runtime.getAuth(config.auth.provider))?.auth
          .apiKey;
        if (!token) throw new Error("Sign in to the selected provider first");
        this.remember(token);
        headers = { ...config.headers, Authorization: `Bearer ${token}` };
      } else if (
        !Object.keys(config.headers ?? {}).some(
          (key) => key.toLowerCase() === "authorization",
        )
      )
        auth = adaptOAuthProvider(
          new McpOAuthProvider({
            serverUrl: config.url,
            redirectUrl:
              config.oauth?.callbackUrl ?? "http://127.0.0.1/callback",
            clientMetadata: {
              client_name: config.oauth?.clientName ?? "WorkLens",
            },
            clientId: config.oauth?.clientId,
            clientSecret:
              config.oauth?.clientSecret &&
              this.resolveValue(config.oauth.clientSecret),
            store: this.credentials.forServer(config.url),
            onRedirect: () => {
              throw new Error("Sign in to this MCP server first");
            },
          }),
        );
    }
    const client = new McpClient({
      name: "WorkLens",
      version: "0.1.0",
      requestTimeoutMs: (config.timeout ?? 15) * 1000,
    });
    const transport = this.transport(
      headers && "url" in config ? { ...config, headers } : config,
      cwd,
      auth,
    );
    try {
      await client.connect(transport);
      const tools = client.serverCapabilities?.tools
        ? await client.listTools()
        : [];
      return { tools: tools.length };
    } catch (error) {
      throw new Error(this.redact(String(error)));
    } finally {
      await client.close();
      await transport.close();
    }
  }
  async login(name: string, loginId: string) {
    if (this.logins.has(loginId)) throw new Error("Sign-in is already running");
    const config = this.server(name);
    if (
      !("url" in config) ||
      config.auth ||
      Object.keys(config.headers ?? {}).some(
        (key) => key.toLowerCase() === "authorization",
      )
    )
      throw new Error("This server does not use MCP OAuth");
    const controller = new AbortController();
    if ([...this.logins.values()].some((login) => login.url === config.url))
      throw new Error("Sign-in is already running for this server");
    this.logins.set(loginId, { controller, url: config.url });
    const timeout = setTimeout(() => controller.abort(), 10 * 60 * 1000);
    const originalStore = this.credentials.forServer(config.url);
    const stored = {
      ...originalStore,
      save: (state: McpOAuthState) => {
        controller.signal.throwIfAborted();
        originalStore.save(state);
      },
    };
    let callback: OAuthCallbackServer | undefined;
    try {
      const uri = config.oauth?.callbackUrl
        ? new URL(config.oauth.callbackUrl)
        : undefined;
      const registered = stored.load()?.clientInformation;
      const registeredUri =
        registered && "redirect_uris" in registered
          ? registered.redirect_uris?.[0]
          : undefined;
      const port =
        (uri ? Number(uri.port || 80) : undefined) ||
        config.oauth?.callbackPort ||
        (registeredUri
          ? Number(new URL(registeredUri).port) || undefined
          : undefined);
      callback = await OAuthCallbackServer.listen({
        port,
        path: uri ? uri.pathname : "/callback",
        host: uri?.hostname === "[::1]" ? "::1" : "127.0.0.1",
        redirectHost: uri ? uri.hostname.replace(/^\[|\]$/g, "") : undefined,
        timeoutMs: 10 * 60 * 1000,
      });
      const previous = stored.load();
      if (previous) {
        const next = { ...previous };
        delete next.oauthState;
        delete next.codeVerifier;
        if (!config.oauth?.clientId && registeredUri !== callback.redirectUrl) {
          delete next.clientInformation;
          delete next.tokens;
          delete next.tokensExpireAt;
        }
        stored.save(next);
      }
      let authorizationUrl: URL | undefined;
      const provider = new McpOAuthProvider({
        serverUrl: config.url,
        redirectUrl: callback.redirectUrl,
        clientMetadata: { client_name: config.oauth?.clientName ?? "WorkLens" },
        clientId: config.oauth?.clientId,
        clientSecret:
          config.oauth?.clientSecret &&
          this.resolveValue(config.oauth.clientSecret),
        store: stored,
        onRedirect: (url) => {
          authorizationUrl = url;
        },
      });
      const abortFetch: typeof fetch = (input, init) =>
        fetch(input, {
          ...init,
          signal: init?.signal
            ? AbortSignal.any([init.signal, controller.signal])
            : controller.signal,
        });
      if (
        (await authorizeMcp(provider, {
          serverUrl: config.url,
          scope: config.oauth?.scope,
          fetch: abortFetch,
        })) === "REDIRECT"
      ) {
        if (!authorizationUrl) throw new Error("Missing authorization URL");
        const abort = () => {
          void callback?.close();
        };
        controller.signal.addEventListener("abort", abort, { once: true });
        try {
          controller.signal.throwIfAborted();
          const pending = callback.waitForCallback(await provider.state());
          pending.catch(() => {});
          this.emit({ loginId, type: "auth_url", url: authorizationUrl.href });
          await this.openUrl(authorizationUrl.href);
          const result = await pending;
          await authorizeMcp(provider, {
            serverUrl: config.url,
            authorizationCode: result.code,
            scope: config.oauth?.scope,
            fetch: abortFetch,
          });
        } finally {
          controller.signal.removeEventListener("abort", abort);
        }
      }
      this.revision++;
      this.emit({ loginId, type: "complete" });
    } catch (error) {
      throw new Error(this.redact(String(error)));
    } finally {
      clearTimeout(timeout);
      await callback?.close();
      this.logins.delete(loginId);
    }
  }
  cancel(loginId: string) {
    this.logins.get(loginId)?.controller.abort();
  }
  cancelLogins() {
    for (const login of this.logins.values()) login.controller.abort();
  }
  async logout(name: string) {
    const config = this.server(name);
    if ("url" in config) {
      for (const login of this.logins.values())
        if (login.url === config.url) login.controller.abort();
      await this.credentials
        .forServer(config.url)
        .withRefreshLock(async () => this.credentials.remove(config.url));
    }
    this.revision++;
    return this.snapshot();
  }
  async shutdown() {
    this.stopping = true;
    this.cancelLogins();
    await Promise.allSettled(
      [...this.transports].map((transport) => transport.close()),
    );
    this.transports.clear();
  }
}
