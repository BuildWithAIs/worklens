import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ToolQueue } from "../tool-queue";
import { waitForTool } from "../tool-wait";

type Service = "GitHub" | "Jira" | "Confluence" | "Jev";
type Limit = { delayMs: number; retryable: boolean };
const gates = new WeakMap<typeof fetch, Map<string, RequestGate>>();

/** Do not retain credentials in scheduler keys or expose them in errors. */
export function requestGate(
  service: Service,
  site: string,
  credential: string,
  fetcher: typeof fetch,
) {
  let entries = gates.get(fetcher);
  if (!entries) gates.set(fetcher, (entries = new Map()));
  const key = createHash("sha256")
    .update(JSON.stringify([service, site, credential]))
    .digest("hex");
  let gate = entries.get(key);
  if (!gate) entries.set(key, (gate = new RequestGate(service)));
  return gate;
}

/** Seconds (including fractional seconds) and HTTP dates, never an early retry. */
export function retryAfterMs(value: string | null, now = Date.now()) {
  if (!value?.trim()) return undefined;
  const text = value.trim();
  const result = /^\d+(\.\d+)?$/.test(text)
    ? Number(text) * 1000
    : Date.parse(text) - now;
  return Number.isFinite(result) ? Math.max(0, result) : undefined;
}

export function retryBackoff(attempt: number, base = 500) {
  return Math.ceil(
    Math.min(30_000, base * 2 ** Math.min(attempt, 10)) *
      (1 + Math.random() * 0.3),
  );
}

/** Shared by settings and tool clients, and retained across credential reloads.
 * No response cache: ordinary reads still fetch current data.
 */
class RequestGate {
  private queue: ToolQueue;
  private until = 0;
  private failures = 0;
  private nextWrite = 0;
  private limits = new WeakMap<Response, Limit>();
  constructor(private service: Service) {
    this.queue = new ToolQueue(service === "GitHub" ? 1 : 4);
  }

  limit(response: Response) {
    return this.limits.get(response);
  }

  // GitHub may report secondary limits in a 403 body, or GraphQL errors in 200.
  recordLimit(headers: Headers) {
    if (this.until > Date.now()) return this.until - Date.now();
    const response = new Response(null, { status: 429, headers });
    this.observe(response);
    return this.limits.get(response)!.delayMs;
  }

  async fetch(
    signal: AbortSignal,
    write: boolean,
    blocked: (wait: number) => Error,
    execute: () => Promise<Response>,
    consume?: (response: Response) => Promise<Response>,
  ) {
    return this.queue.run(signal, async () => {
      signal.throwIfAborted();
      if (this.until > Date.now()) throw blocked(this.until - Date.now());
      if (write && this.service === "GitHub") {
        const wait = this.nextWrite - Date.now();
        if (wait > 0)
          await waitForTool("interval", () =>
            delay(wait, undefined, { signal }),
          );
        signal.throwIfAborted();
        this.nextWrite = Date.now() + 1000;
      }
      const response = await execute();
      this.observe(response);
      const result = consume ? await consume(response) : response;
      if (result.ok && this.until <= Date.now()) this.failures = 0;
      const limit = this.limits.get(response);
      if (limit && result !== response) this.limits.set(result, limit);
      return result;
    });
  }

  private observe(response: Response) {
    const now = Date.now();
    const retry = retryAfterMs(response.headers.get("retry-after"), now);
    const remaining = response.headers.get("x-ratelimit-remaining");
    const reset = response.headers.get("x-ratelimit-reset");
    const resetAt = reset
      ? this.service === "GitHub"
        ? Number(reset) * 1000
        : Date.parse(reset)
      : NaN;
    const limited =
      response.status === 429 ||
      (this.service === "GitHub" &&
        response.status === 403 &&
        (retry !== undefined || remaining === "0")) ||
      (this.service === "Jev" && response.status === 529);
    if (limited) {
      const attempt = this.failures++;
      const base =
        this.service === "GitHub" && retry === undefined
          ? 60_000
          : this.service === "Jira" || this.service === "Confluence"
            ? 2000
            : 500;
      const backoff =
        this.service === "GitHub" && retry === undefined
          ? Math.min(15 * 60_000, base * 2 ** Math.min(attempt, 4))
          : retryBackoff(attempt, base);
      const wait = Math.max(
        backoff,
        retry ?? 0,
        remaining === "0" && Number.isFinite(resetAt) ? resetAt - now : 0,
      );
      this.until = Math.max(this.until, now + wait);
      this.limits.set(response, {
        delayMs: this.until - now,
        // Atlassian: only retry an idempotent API when Retry-After is present.
        retryable:
          this.service === "GitHub" ||
          this.service === "Jev" ||
          retry !== undefined,
      });
    } else if (response.ok) {
      if (remaining === "0" && Number.isFinite(resetAt))
        this.until = Math.max(this.until, resetAt);
    }
    // A Retry-After on service unavailability is also a minimum, not a cap.
    if (response.status >= 500 && retry !== undefined)
      this.until = Math.max(this.until, now + retry);
  }
}
