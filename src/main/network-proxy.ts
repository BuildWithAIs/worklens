import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { isIP, type LookupFunction } from "node:net";
import {
  Agent,
  Dispatcher,
  Pool,
  ProxyAgent,
  buildConnector,
  fetch as undiciFetch,
  getGlobalDispatcher,
  setGlobalDispatcher,
} from "undici";
import type { ProxyConfig } from "electron";
import type {
  NetworkStatus,
  ProxyDetection,
  ProxySettings,
} from "../shared/contracts";
import { markProxyFailure, NetworkHealth } from "./network-health";
import { NetworkBypass } from "./network-bypass";
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
const DNS_TIMEOUT_MS = 2000;
const MAX_ROUTES = 256;
const MAX_DNS_LOOKUPS = 32;
const DEFAULT_SETTINGS: ProxySettings = { mode: "system" };

/** Resolved bypass addresses are pinned so mixed DNS answers cannot leak direct. */
type ResolvedDirect = { addresses: LookupAddress[]; agent?: Agent };
type Route = string | undefined | ResolvedDirect;

/**
 * Resolves a bypassed host only to its pinned addresses. It answers on a
 * later tick, as DNS does: Node connects inside the answer, and a connect that
 * fails at once (EADDRNOTAVAIL after a network change) would otherwise throw
 * before Undici attaches its error handler and crash the main process.
 */
export function bypassLookup(pinned: LookupAddress[]): LookupFunction {
  return (_hostname, options, callback) =>
    process.nextTick(answer, options, callback);
  function answer(
    options: Parameters<LookupFunction>[1],
    callback: Parameters<LookupFunction>[2],
  ) {
    const addresses = pinned.filter(
      ({ family }) => !options.family || family === options.family,
    );
    if (!addresses.length) {
      callback(
        Object.assign(new Error("No matching bypass address"), {
          code: "ENOTFOUND",
        }),
        "",
        0,
      );
      return;
    }
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  }
}

/** Register cancellation before asynchronous routing, then hand it to Undici. */
class PendingDispatch {
  private downstream?: Dispatcher.DispatchController;
  private downstreamAbort?: (error: Error) => void;
  private reason: Error | null = null;
  private paused = false;
  readonly controller: Dispatcher.DispatchController;
  readonly handler: Dispatcher.DispatchHandler;

  constructor(private readonly original: Dispatcher.DispatchHandler) {
    const pending = this;
    this.controller = {
      get aborted() {
        return !!pending.reason || !!pending.downstream?.aborted;
      },
      get reason() {
        return pending.reason ?? pending.downstream?.reason ?? null;
      },
      get paused() {
        return pending.downstream?.paused ?? pending.paused;
      },
      abort(error) {
        if (pending.downstream) pending.downstream.abort(error);
        else if (pending.downstreamAbort) pending.downstreamAbort(error);
        else pending.fail(error ?? new Error("Request aborted"));
      },
      pause() {
        pending.paused = true;
        pending.downstream?.pause();
      },
      resume() {
        pending.paused = false;
        pending.downstream?.resume();
      },
    };
    // Bind delegated methods to their original receiver (handlers may have
    // private fields). Both Undici's legacy and current handler APIs are used.
    this.handler = new Proxy(original, {
      get(target, key) {
        if (key === "onRequestStart" && target.onRequestStart)
          return (controller: Dispatcher.DispatchController) => {
            pending.downstream = controller;
            if (pending.reason) controller.abort(pending.reason);
            else if (pending.paused) controller.pause();
          };
        if (key === "onConnect" && !target.onRequestStart)
          return (abort: (error: Error) => void) => {
            pending.downstreamAbort = abort;
            if (pending.reason) abort(pending.reason);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    if (original.onRequestStart) original.onRequestStart(this.controller, null);
    else
      original.onConnect?.((error) =>
        this.controller.abort(error ?? new Error("Request aborted")),
      );
  }

  fail(error: Error) {
    if (this.reason) return;
    this.reason = error;
    if (this.original.onResponseError)
      this.original.onResponseError(this.controller, error);
    else this.original.onError?.(error);
  }
}

export interface ProxyHost {
  onStatus?(status: NetworkStatus): void;
  /** Chromium's PAC-style proxy result for a URL, using system settings. */
  resolveSystem(url: string): Promise<string>;
  setSessionProxy(config: ProxyConfig): Promise<void>;
  readShellProxy?(env: NodeJS.ProcessEnv): Promise<string | undefined>;
  resolveAddresses?(hostname: string): Promise<LookupAddress[]>;
}

/** Routes each origin directly or through a proxy, following live settings. */
export class ProxyRouter extends Dispatcher {
  private readonly agents = new Map<string, ProxyAgent>();
  private readonly retiring = new Set<Agent>();
  private readonly waiting = new Set<PendingDispatch>();
  private generation = 0;
  private stopped = false;
  private bypass = new NetworkBypass();
  private dnsLookups = 0;
  private readonly cache = new Map<
    string,
    { route: Route | Promise<Route>; expires: number }
  >();

  constructor(
    private readonly direct: Dispatcher,
    private readonly settings: () => ProxySettings,
    private readonly resolveSystem: (
      url: string,
    ) => Promise<string | undefined>,
    private readonly resolveAddresses = (hostname: string) =>
      lookup(hostname, { all: true }),
    private readonly health?: NetworkHealth,
  ) {
    super();
    this.reset();
  }

  route(origin: string): Route | Promise<Route> {
    const settings = this.settings();
    const { hostname } = new URL(origin);
    if (settings.mode === "off" || bypassesProxy(hostname, proxyBypassList()))
      return undefined;
    if (settings.mode === "custom") {
      if (this.bypass.matches(hostname)) return undefined;
      const proxy = settings.url && normalizeProxyUrl(settings.url);
      if (
        !proxy ||
        !this.bypass.hasSubnets ||
        isIP(hostname.replace(/^\[|\]$/g, ""))
      )
        return proxy;
      return this.cached(origin, () => this.resolveBypass(hostname, proxy));
    }
    return this.cached(origin, () => this.resolveSystem(origin));
  }

  private cached(origin: string, resolve: () => Promise<Route>) {
    const cached = this.cache.get(origin);
    if (cached && cached.expires > Date.now()) return cached.route;
    if (cached) this.evict(origin);
    while (this.cache.size >= MAX_ROUTES)
      this.evict(this.cache.keys().next().value!);
    const entry: { route: Route | Promise<Route>; expires: number } = {
      route: undefined,
      expires: Date.now() + SYSTEM_REFRESH_MS,
    };
    const route = resolve().then((value) => {
      // A settings change or eviction must not be undone by an old DNS result.
      if (this.cache.get(origin) === entry) {
        this.cache.set(origin, {
          route: value,
          expires: Date.now() + SYSTEM_REFRESH_MS,
        });
      }
      return value;
    });
    entry.route = route;
    this.cache.set(origin, entry);
    return route;
  }

  private async resolveBypass(hostname: string, proxy: string): Promise<Route> {
    // dns.lookup uses the OS thread pool and cannot be cancelled. Bound even
    // timed-out lookups until the OS completes them.
    if (this.dnsLookups >= MAX_DNS_LOOKUPS) return proxy;
    this.dnsLookups++;
    const bypass = this.bypass;
    let timer: NodeJS.Timeout | undefined;
    try {
      const lookup = Promise.resolve()
        .then(() => this.resolveAddresses(hostname))
        .finally(() => this.dnsLookups--);
      const addresses = await Promise.race([
        lookup,
        new Promise<LookupAddress[]>((resolve) => {
          timer = setTimeout(() => resolve([]), DNS_TIMEOUT_MS);
        }),
      ]);
      const matching = addresses.filter(({ address }) =>
        bypass.matchesSubnet(address),
      );
      return matching.length ? { addresses: matching } : proxy;
    } catch {
      // A proxy may resolve hosts unavailable to the local DNS resolver.
      return proxy;
    } finally {
      clearTimeout(timer);
    }
  }

  private evict(origin: string) {
    const route = this.cache.get(origin)?.route;
    this.cache.delete(origin);
    if (
      route &&
      typeof route === "object" &&
      !(route instanceof Promise) &&
      route.agent
    ) {
      this.retire(route.agent);
    }
  }

  private retire(agent: Agent) {
    if (this.retiring.has(agent)) return;
    this.retiring.add(agent);
    void agent
      .close()
      .catch(() => {})
      .finally(() => this.retiring.delete(agent));
  }

  reset() {
    this.generation++;
    this.bypass = new NetworkBypass(this.settings().bypass);
    for (const origin of this.cache.keys()) this.evict(origin);
  }

  dispatch(
    options: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandler,
  ) {
    if (this.stopped) {
      this.fail(handler, new Error("Proxy router is closed"));
      return false;
    }
    let generation = this.generation;
    const route = this.route(String(options.origin));
    if (!(route instanceof Promise))
      return this.dispatchTo(route, options, handler);
    const pending = new PendingDispatch(handler);
    this.waiting.add(pending);
    // DNS and system proxy resolution are asynchronous; follow current settings
    // without registering a second cancellation handler after a settings change.
    void (async () => {
      try {
        let value = await route;
        while (
          !pending.controller.aborted &&
          !this.stopped &&
          generation !== this.generation
        ) {
          generation = this.generation;
          value = await this.route(String(options.origin));
        }
        if (pending.controller.aborted) return;
        if (this.stopped) pending.fail(new Error("Proxy router is closed"));
        else this.dispatchTo(value, options, pending.handler);
      } catch (error) {
        pending.fail(error as Error);
      } finally {
        this.waiting.delete(pending);
      }
    })();
    return true;
  }

  private dispatchTo(
    route: Route,
    options: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandler,
  ) {
    const target = this.target(route);
    const hostname = new URL(String(options.origin)).hostname;
    const kind =
      typeof route === "string"
        ? "proxy"
        : this.settings().mode === "custom" &&
            !bypassesProxy(hostname, proxyBypassList()) &&
            (typeof route === "object" || this.bypass.matches(hostname))
          ? "bypass"
          : undefined;
    if (kind && this.health)
      handler = this.health.observe(
        String(options.origin),
        kind,
        handler,
        typeof route === "string" ? route : "bypass",
      );
    try {
      return target.dispatch(options, handler);
    } finally {
      // An in-flight resolution can outlive a cache eviction. Drain its agent
      // after this dispatch rather than leave an uncached connection pool alive.
      if (
        typeof route === "object" &&
        this.cache.get(String(options.origin))?.route !== route
      )
        this.retire(route.agent!);
    }
  }

  private fail(handler: Dispatcher.DispatchHandler, error: Error) {
    new PendingDispatch(handler).fail(error);
  }

  private target(route: Route): Dispatcher {
    if (!route) return this.direct;
    if (typeof route === "object") {
      route.agent ??= new Agent({
        connect: { lookup: bypassLookup(route.addresses) },
      });
      return route.agent;
    }
    let agent = this.agents.get(route);
    if (!agent) {
      agent = new ProxyAgent({
        uri: route,
        // The proxy's own client opens each tunnel; what it throws happened
        // while reaching the proxy, before the destination was involved.
        clientFactory: (origin, options) => {
          const poolOptions = options as Pool.Options;
          const proxyConnect =
            typeof poolOptions.connect === "function"
              ? poolOptions.connect
              : buildConnector(poolOptions.connect);
          const client = new Pool(origin, {
            ...poolOptions,
            connect: (params, callback) => {
              // Sanitize SNI at the socket boundary. Clearing it on CONNECT
              // instead makes Undici fall back to the destination's Host.
              const servername = params.servername;
              proxyConnect(
                servername && isIP(servername.replace(/^\[|\]$/g, ""))
                  ? { ...params, servername: undefined }
                  : params,
                callback,
              );
            },
          });
          const connect = client.connect.bind(client);
          client.connect = (async (params: Dispatcher.ConnectOptions) => {
            try {
              return await connect(params);
            } catch (error) {
              markProxyFailure(error);
              throw error;
            }
          }) as typeof client.connect;
          return client;
        },
      });
      this.agents.set(route, agent);
    }
    return agent;
  }

  private stop() {
    this.stopped = true;
    for (const pending of this.waiting)
      pending.fail(new Error("Proxy router is closed"));
    this.waiting.clear();
    this.reset();
  }

  override async close() {
    this.stop();
    const agents = [...this.agents.values()];
    this.agents.clear();
    await Promise.all(
      [...agents, ...this.retiring].map((agent) => agent.close()),
    );
  }

  override async destroy() {
    this.stop();
    const agents = [...this.agents.values()];
    this.agents.clear();
    await Promise.all(
      [...agents, ...this.retiring].map((agent) => agent.destroy()),
    );
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
  private readonly health: NetworkHealth;
  private timer?: NodeJS.Timeout;

  constructor(private readonly host: ProxyHost) {
    this.original = { ...process.env };
    this.health = new NetworkHealth((status) => host.onStatus?.(status));
    this.router = new ProxyRouter(
      this.previous,
      () => this.settings,
      (url) => this.system(url),
      host.resolveAddresses,
      this.health,
    );
    setGlobalDispatcher(this.router);
  }

  async apply(settings: ProxySettings = DEFAULT_SETTINGS) {
    this.settings = settings;
    this.health.reset();
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

  status(): NetworkStatus {
    return this.health.snapshot();
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
      this.host.resolveAddresses,
    );
    router.reset();
    const route = await router.route(new URL(PROXY_PROBE_URL).origin);
    const proxy = typeof route === "string" ? route : undefined;
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
    // Windows variable names are case-insensitive: HTTPS_PROXY and https_proxy
    // are one variable. Write it once, so restoring the lowercase name cannot
    // delete the launch value, and read the launch value under any casing.
    const windows = process.platform === "win32";
    const keys = windows
      ? ENV_KEYS.filter((key) => key === key.toUpperCase())
      : ENV_KEYS;
    for (const key of keys) {
      const value = proxy
        ? /no_proxy/i.test(key)
          ? bypass.join(",")
          : proxy
        : windows
          ? Object.entries(this.original).find(
              ([name]) => name.toUpperCase() === key,
            )?.[1]
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
