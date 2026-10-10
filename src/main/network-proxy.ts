import { spawn } from "node:child_process";
import {
  Agent,
  Dispatcher,
  ProxyAgent,
  fetch as undiciFetch,
  getGlobalDispatcher,
  setGlobalDispatcher,
} from "undici";
import type { ProxyConfig } from "electron";
import type { ProxyDetection, ProxySettings } from "../shared/contracts";
import {
  PROXY_PROBE_URL,
  bypassesProxy,
  normalizeProxyUrl,
  parseProxyRule,
  proxyBypassList,
} from "../shared/network-proxy";

const ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;
// System proxies can change at any time (for example when Clash is toggled).
const SYSTEM_REFRESH_MS = 30_000;
const DEFAULT_SETTINGS: ProxySettings = { mode: "system" };

/** A proxy origin, or undefined for a direct connection. */
type Route = string | undefined;

export interface ProxyHost {
  /** Chromium's PAC-style proxy result for a URL, using system settings. */
  resolveSystem(url: string): Promise<string>;
  setSessionProxy(config: ProxyConfig): Promise<void>;
  readShellProxy?(env: NodeJS.ProcessEnv): Promise<string | undefined>;
}

/** Routes each origin directly or through a proxy, following live settings. */
class ProxyRouter extends Dispatcher {
  private readonly agents = new Map<string, ProxyAgent>();
  private readonly cache = new Map<
    string,
    { route: Route | Promise<Route>; expires: number }
  >();

  constructor(
    private readonly direct: Dispatcher,
    private readonly settings: () => ProxySettings,
    private readonly resolveSystem: (url: string) => Promise<Route>,
  ) {
    super();
  }

  route(origin: string): Route | Promise<Route> {
    const settings = this.settings();
    const { hostname } = new URL(origin);
    if (settings.mode === "off" || bypassesProxy(hostname, proxyBypassList()))
      return undefined;
    if (settings.mode === "custom")
      return settings.url &&
        !bypassesProxy(hostname, proxyBypassList(settings.bypass))
        ? normalizeProxyUrl(settings.url)
        : undefined;
    const cached = this.cache.get(origin);
    if (cached && cached.expires > Date.now()) return cached.route;
    const route = this.resolveSystem(origin);
    this.cache.set(origin, { route, expires: Date.now() + SYSTEM_REFRESH_MS });
    void route.then((value) =>
      this.cache.set(origin, {
        route: value,
        expires: Date.now() + SYSTEM_REFRESH_MS,
      }),
    );
    return route;
  }

  reset() {
    this.cache.clear();
  }

  dispatch(
    options: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandler,
  ) {
    const route = this.route(String(options.origin));
    if (!(route instanceof Promise))
      return this.target(route).dispatch(options, handler);
    // System proxy resolution is asynchronous; dispatch once it is known.
    void route.then((value) => {
      try {
        this.target(value).dispatch(options, handler);
      } catch (error) {
        if (handler.onResponseError)
          handler.onResponseError(null as never, error as Error);
        else handler.onError?.(error as Error);
      }
    });
    return true;
  }

  private target(route: Route): Dispatcher {
    if (!route) return this.direct;
    let agent = this.agents.get(route);
    if (!agent) {
      agent = new ProxyAgent({ uri: route });
      this.agents.set(route, agent);
    }
    return agent;
  }

  override async close() {
    const agents = [...this.agents.values()];
    this.agents.clear();
    await Promise.all(agents.map((agent) => agent.close()));
  }

  override async destroy() {
    const agents = [...this.agents.values()];
    this.agents.clear();
    await Promise.all(agents.map((agent) => agent.destroy()));
  }
}

/**
 * Applies one proxy setting to every request path: Node fetch in the main
 * process, Electron sessions, and child processes (agent commands and local
 * MCP servers) through HTTP(S)_PROXY.
 */
export class NetworkProxy {
  private settings = DEFAULT_SETTINGS;
  private readonly original: NodeJS.ProcessEnv;
  private readonly previous = getGlobalDispatcher();
  private readonly router: ProxyRouter;
  private timer?: NodeJS.Timeout;

  constructor(private readonly host: ProxyHost) {
    this.original = { ...process.env };
    this.router = new ProxyRouter(
      this.previous,
      () => this.settings,
      (url) => this.system(url),
    );
    setGlobalDispatcher(this.router);
  }

  async apply(settings: ProxySettings = DEFAULT_SETTINGS) {
    this.settings = settings;
    this.router.reset();
    clearInterval(this.timer);
    this.timer = undefined;
    await this.host.setSessionProxy(sessionConfig(settings));
    await this.refreshEnvironment();
    if (settings.mode === "system") {
      this.timer = setInterval(() => {
        void this.refreshEnvironment().catch(() => {});
      }, SYSTEM_REFRESH_MS);
      this.timer.unref();
    }
  }

  async detect(shell = false): Promise<ProxyDetection> {
    const { proxy, unsupported } = parseProxyRule(
      await this.host.resolveSystem(PROXY_PROBE_URL),
    );
    let environment = environmentProxy(this.original);
    // The login shell is read with the launch environment, so values WorkLens
    // injected for child processes are not reported back as detected.
    if (!environment && shell)
      environment = await this.host.readShellProxy?.(this.original);
    return { system: proxy, unsupported, environment };
  }

  /** Requests the probe address with the given settings, without applying them. */
  async test(settings: ProxySettings) {
    const direct = new Agent();
    const router = new ProxyRouter(
      direct,
      () => settings,
      (url) => this.system(url),
    );
    const proxy = await router.route(new URL(PROXY_PROBE_URL).origin);
    try {
      await undiciFetch(PROXY_PROBE_URL, {
        method: "HEAD",
        redirect: "manual",
        dispatcher: router,
        signal: AbortSignal.timeout(10_000),
      });
      return { proxy };
    } catch (error) {
      const reason =
        error instanceof Error && error.name === "TimeoutError"
          ? "Connection timed out"
          : "Could not reach";
      throw new Error(
        proxy
          ? `${reason} the network through proxy ${proxy}`
          : `${reason} the network test address`,
      );
    } finally {
      await Promise.all([router.destroy(), direct.destroy()]);
    }
  }

  /** Restores the previous dispatcher and environment (tests and shutdown). */
  async dispose() {
    clearInterval(this.timer);
    setGlobalDispatcher(this.previous);
    this.writeEnvironment(undefined);
    await this.router.close();
  }

  /** Falls back to a direct connection if the system proxy can't be read. */
  private async system(url: string) {
    try {
      return parseProxyRule(await this.host.resolveSystem(url)).proxy;
    } catch {
      return undefined;
    }
  }

  private async refreshEnvironment() {
    const { mode, url, bypass } = this.settings;
    const proxy =
      mode === "custom"
        ? url && normalizeProxyUrl(url)
        : mode === "system"
          ? await this.system(PROXY_PROBE_URL)
          : undefined;
    this.writeEnvironment(
      proxy || undefined,
      proxyBypassList(mode === "custom" ? bypass : ""),
    );
  }

  private writeEnvironment(proxy: string | undefined, bypass: string[] = []) {
    for (const key of ENV_KEYS) {
      const value = proxy
        ? /no_proxy/i.test(key)
          ? bypass.join(",")
          : proxy
        : this.original[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function sessionConfig(settings: ProxySettings): ProxyConfig {
  const proxy =
    settings.mode === "custom" && settings.url
      ? normalizeProxyUrl(settings.url)
      : undefined;
  if (proxy)
    return {
      mode: "fixed_servers",
      proxyRules: proxy,
      proxyBypassRules: proxyBypassList(settings.bypass).join(","),
    };
  return { mode: settings.mode === "off" ? "direct" : "system" };
}

function environmentProxy(env: NodeJS.ProcessEnv) {
  for (const key of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"])
    if (env[key]) {
      const proxy = normalizeProxyUrl(env[key]);
      if (proxy) return proxy;
    }
  return undefined;
}

/** Reads HTTP(S)_PROXY exported by the user's login shell (macOS and Linux). */
export function readShellProxy(env: NodeJS.ProcessEnv) {
  if (process.platform === "win32") return Promise.resolve(undefined);
  const marker = "__WORKLENS_PROXY__";
  const keys = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"];
  const script = `printf '${marker}%s\\n' ${keys.map((key) => `"$${key}"`).join(" ")}`;
  return new Promise<string | undefined>((resolve) => {
    const child = spawn(env.SHELL || "/bin/sh", ["-ilc", script], {
      env,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    const timer = setTimeout(() => child.kill(), 3000);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.on("close", () => {
      clearTimeout(timer);
      const values = output
        .split("\n")
        .filter((line) => line.startsWith(marker))
        .map((line) => line.slice(marker.length));
      resolve(
        environmentProxy(
          Object.fromEntries(keys.map((k, i) => [k, values[i]])),
        ),
      );
    });
  });
}
