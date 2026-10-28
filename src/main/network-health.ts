import type { Dispatcher } from "undici";
import type { NetworkStatus } from "../shared/contracts";

const NETWORK_CODES = new Set([
  "EADDRNOTAVAIL",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_PRX_TLS",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

// Failures to connect at all. Past this point the destination itself answered,
// so its certificate, resets and slow responses are its own, not the route's.
const CONNECT_CODES = new Set([
  "EADDRNOTAVAIL",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/** The error and its causes, bounded so unusual objects cannot loop. */
function* causes(error: unknown) {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  for (let count = 0; pending.length && count < 16; count++) {
    const value = pending.shift();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    yield value;
    const { cause, errors } = value as { cause?: unknown; errors?: unknown };
    if (cause) pending.push(cause);
    if (Array.isArray(errors)) pending.push(...errors.slice(0, 16));
  }
}

/** Classifies transport failures only; never sends error text or destinations. */
export function networkErrorCode(error: unknown): string | undefined {
  for (const value of causes(error)) {
    const { code } = value as { code?: unknown };
    if (typeof code === "string" && NETWORK_CODES.has(code)) return code;
  }
  return undefined;
}

const proxyStage = new WeakSet<object>();
/** Marks an error raised while reaching the proxy, before any tunnel exists. */
export function markProxyFailure(error: unknown) {
  if (error && typeof error === "object") proxyStage.add(error);
}

type RouteKind = "proxy" | "bypass";

/** Whether `error` shows the route itself failing rather than the destination. */
function routeFailure(kind: RouteKind, error: Error) {
  if (kind === "bypass") {
    const code = networkErrorCode(error);
    return !!code && CONNECT_CODES.has(code);
  }
  const tunnel =
    (error as Error & { code?: string }).code === "UND_ERR_ABORTED"
      ? /^Proxy response \((\d{3})\) !== 200 when HTTP Tunneling$/.exec(
          error.message,
        )
      : null;
  // A 5xx answer to CONNECT comes from a working proxy that couldn't reach
  // the destination: the destination failed, not the route.
  if (tunnel) return Number(tunnel[1]) < 500;
  // Through a tunnel the destination reports the same codes, certificates
  // included, so only errors raised while reaching the proxy count.
  return (
    [...causes(error)].some((value) => proxyStage.has(value)) &&
    !!networkErrorCode(error)
  );
}
/** `failedUntil` is set while the destination's last outcome was a failure. */
type Observation = { route: string; kind: RouteKind; failedUntil?: number };

// A failure that is never retried, such as a one-off tool request, must not
// warn for the rest of the session.
export const FAILURE_TTL_MS = 5 * 60_000;

/** Session-only, bounded status of actual requests, independent of saved settings. */
export class NetworkHealth {
  private revision = 0;
  private readonly origins = new Map<string, Observation>();
  private status: NetworkStatus = { revision: 0, proxy: false, bypass: false };
  private expiry?: NodeJS.Timeout;

  constructor(private readonly changed: (status: NetworkStatus) => void) {}

  snapshot(): NetworkStatus {
    return { ...this.status };
  }

  reset() {
    this.origins.clear();
    this.publish();
  }

  observe(
    origin: string,
    kind: RouteKind,
    handler: Dispatcher.DispatchHandler,
    route = kind as string,
  ) {
    const previous = this.origins.get(origin);
    const observation: Observation = {
      route,
      kind,
      failedUntil:
        previous?.route === route && previous.kind === kind
          ? previous.failedUntil
          : undefined,
    };
    this.origins.delete(origin);
    // Bound memory even when tools request many different destinations.
    if (this.origins.size >= 256) {
      const healthy = [...this.origins].find(
        ([, value]) => value.failedUntil === undefined,
      );
      // Keep known failures until their own destination recovers or settings
      // change. Unrelated successful requests must never evict a warning.
      if (!healthy) return handler;
      this.origins.delete(healthy[0]);
    }
    this.origins.set(origin, observation);
    if (previous && previous.route !== route) this.publish();
    let aborted = false;
    const finish = (error?: Error) => {
      if (aborted || this.origins.get(origin) !== observation) return;
      try {
        if (error && !routeFailure(kind, error)) return;
        observation.failedUntil = error
          ? Date.now() + FAILURE_TTL_MS
          : undefined;
        this.publish();
      } catch {
        /* Diagnostics must not alter request delivery. */
      }
    };
    return new Proxy(handler, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (typeof value !== "function") return value;
        if (key === "onConnect")
          return (abort: (error?: Error) => void) =>
            value.call(target, (error?: Error) => {
              aborted = true;
              abort(error);
            });
        if (key === "onRequestStart")
          return (
            controller: Dispatcher.DispatchController,
            context: unknown,
          ) => {
            const wrapped = new Proxy(controller, {
              get(owner, property) {
                const member = Reflect.get(owner, property, owner);
                if (property === "abort")
                  return (error: Error) => {
                    aborted = true;
                    controller.abort(error);
                  };
                return typeof member === "function"
                  ? member.bind(owner)
                  : member;
              },
            });
            return value.call(target, wrapped, context);
          };
        if (key === "onError" || key === "onResponseError")
          return (...args: unknown[]) => {
            finish(args[key === "onError" ? 0 : 1] as Error);
            return value.apply(target, args);
          };
        if (key === "onHeaders" || key === "onResponseStart")
          return (...args: unknown[]) => {
            const status = args[key === "onHeaders" ? 0 : 1] as number;
            if (status >= 200) finish();
            return value.apply(target, args);
          };
        return value.bind(target);
      },
    });
  }

  private publish() {
    const now = Date.now();
    let next = Infinity;
    for (const value of this.origins.values()) {
      if (value.failedUntil === undefined) continue;
      if (value.failedUntil <= now) value.failedUntil = undefined;
      else next = Math.min(next, value.failedUntil);
    }
    clearTimeout(this.expiry);
    this.expiry = undefined;
    if (next < Infinity) {
      this.expiry = setTimeout(() => this.publish(), next - now);
      this.expiry.unref?.();
    }
    const values = [...this.origins.values()];
    const failed = (kind: RouteKind) =>
      values.some(
        (value) => value.failedUntil !== undefined && value.kind === kind,
      );
    const proxy = failed("proxy");
    const bypass = failed("bypass");
    if (proxy === this.status.proxy && bypass === this.status.bypass) return;
    this.status = { revision: ++this.revision, proxy, bypass };
    try {
      this.changed(this.snapshot());
    } catch {
      /* Reporting cannot fail requests. */
    }
  }
}
