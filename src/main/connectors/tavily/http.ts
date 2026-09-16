import { setTimeout as delay } from "node:timers/promises";
import type { ConnectionSnapshot } from "./connection";

export type Json = Record<string, any>;
export class ServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}
const MAX_RESPONSE = 8 * 1024 * 1024;

/** Every Tavily call is read-only and idempotent, so transient failures retry. */
export class TavilyHttp {
  readonly signal: AbortSignal;
  constructor(
    readonly connection: ConnectionSnapshot,
    readonly fetcher: typeof fetch = fetch,
    signal?: AbortSignal,
  ) {
    this.signal = AbortSignal.any([
      connection.signal,
      ...(signal ? [signal] : []),
      AbortSignal.timeout(120_000),
    ]);
  }
  async request(method: "GET" | "POST", path: string, body?: Json) {
    const url = `${this.connection.settings.url}${path}`;
    for (let attempt = 0; ; attempt++) {
      this.signal.throwIfAborted();
      let response: Response;
      try {
        response = await this.fetcher(url, {
          method,
          headers: {
            authorization: `Bearer ${this.connection.token}`,
            accept: "application/json",
            ...(body ? { "content-type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          redirect: "manual",
          signal: AbortSignal.any([this.signal, AbortSignal.timeout(60_000)]),
        });
      } catch {
        this.signal.throwIfAborted();
        if (attempt >= 2)
          throw new ServiceError("network", "Tavily 网络请求失败或超时");
        await delay(500 * 2 ** attempt, undefined, { signal: this.signal });
        continue;
      }
      const status = response.status;
      if (
        attempt < 2 &&
        (status === 429 || [500, 502, 503, 504].includes(status))
      ) {
        const retry = response.headers.get("retry-after");
        const wait =
          retry && /^\d+$/.test(retry)
            ? Number(retry) * 1000
            : 500 * 2 ** attempt;
        await response.body?.cancel();
        if (wait > 30_000)
          throw new ServiceError("rate_limit", "Tavily 要求稍后重试", {
            retryAfterMs: wait,
          });
        await delay(wait, undefined, { signal: this.signal });
        continue;
      }
      if (status >= 300 && status < 400) {
        await response.body?.cancel();
        throw new ServiceError("redirect", "Tavily API 返回重定向；未转发凭据");
      }
      if (Number(response.headers.get("content-length")) > MAX_RESPONSE) {
        await response.body?.cancel();
        throw new ServiceError(
          "result_too_large",
          "Tavily 响应超过 8 MiB，请缩小查询范围",
        );
      }
      const text = await response.text();
      let data: Json = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        if (response.ok)
          throw new ServiceError("http", "Tavily 返回了无法解析的响应");
      }
      if (response.ok) return data;
      const detail =
        typeof data.detail === "string"
          ? data.detail
          : typeof data.detail?.error === "string"
            ? data.detail.error
            : typeof data.error === "string"
              ? data.error
              : "";
      const code =
        status === 401
          ? "authentication"
          : status === 429
            ? "rate_limit"
            : status === 432 || status === 433
              ? "quota"
              : status === 400 || status === 422
                ? "invalid_request"
                : "http";
      throw new ServiceError(code, `Tavily 返回 ${status}。${detail}`, {
        status,
      });
    }
  }
}
