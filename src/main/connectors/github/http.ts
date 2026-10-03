import { Octokit } from "octokit";
import { trackToolTask, toolRetryDelay as delay } from "../../tool-wait";
import { apiAddresses, type ConnectionSnapshot } from "./connection";
import { requestGate, retryAfterMs, retryBackoff } from "../request-gate";

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
const MAX_RESPONSE = 24 * 1024 * 1024;
export class GitHubHttp {
  readonly addresses;
  readonly signal: AbortSignal;
  private gate;
  constructor(
    readonly connection: ConnectionSnapshot,
    readonly fetcher: typeof fetch = fetch,
    signal?: AbortSignal,
  ) {
    this.addresses = apiAddresses(connection.settings.url);
    this.gate = requestGate(
      "GitHub",
      this.addresses.rest,
      connection.token,
      fetcher,
    );
    this.signal = AbortSignal.any([
      connection.signal,
      ...(signal ? [signal] : []),
      AbortSignal.timeout(180_000),
    ]);
  }
  private rateLimit(wait: number) {
    return new ServiceError("rate_limit", "GitHub 要求稍后重试", {
      retryAfterMs: wait,
    });
  }
  private trusted(raw: string, uploads = false) {
    const url = new URL(raw);
    const base = new URL(
      uploads ? this.addresses.uploads : this.addresses.rest,
    );
    return (
      !url.username &&
      !url.password &&
      !url.hash &&
      url.origin === base.origin &&
      (url.pathname === base.pathname ||
        url.pathname.startsWith(base.pathname.replace(/\/$/, "") + "/") ||
        (!uploads && url.href === this.addresses.graphql))
    );
  }
  private async request(
    url: string,
    init: RequestInit,
    readOnly: boolean,
    uploads = false,
    bounded = false,
  ): Promise<Response> {
    return trackToolTask(async () => {
      if (!this.trusted(url, uploads))
        throw new ServiceError(
          "invalid_target",
          "请求超出当前 GitHub API 范围",
        );
      for (let attempt = 0; ; attempt++) {
        this.signal.throwIfAborted();
        let response: Response;
        try {
          response = await this.gate.fetch(
            this.signal,
            !readOnly,
            (wait) => this.rateLimit(wait),
            async () => {
              const result = await this.fetcher(url, {
                ...init,
                redirect: "manual",
                signal: AbortSignal.any([
                  this.signal,
                  AbortSignal.timeout(30_000),
                ]),
              });
              return bounded
                ? this.boundedResponse(
                    result,
                    readOnly,
                    url === this.addresses.graphql,
                  )
                : result;
            },
          );
        } catch (error) {
          if (error instanceof ServiceError) throw error;
          if (!readOnly)
            throw new ServiceError(
              "unknown",
              "请求已发出，但无法确认写入结果。请读取目标核实，不要重复提交。",
            );
          this.signal.throwIfAborted();
          if (attempt >= 2)
            throw new ServiceError("network", "GitHub 网络请求失败或超时");
          await delay(retryBackoff(attempt), undefined, {
            signal: this.signal,
          });
          continue;
        }
        const limited = this.gate.limit(response);
        if (limited) {
          await response.body?.cancel();
          if (!readOnly || attempt >= 2 || limited.delayMs > 30_000)
            throw this.rateLimit(limited.delayMs);
          await delay(limited.delayMs, undefined, { signal: this.signal });
          continue;
        }
        if (
          readOnly &&
          attempt < 2 &&
          [500, 502, 503, 504].includes(response.status)
        ) {
          const wait = Math.max(
            retryAfterMs(response.headers.get("retry-after")) ?? 0,
            retryBackoff(attempt),
          );
          if (wait > 30000) {
            await response.body?.cancel();
            throw new ServiceError("rate_limit", "GitHub 要求稍后重试", {
              retryAfterMs: wait,
            });
          }
          await response.body?.cancel();
          await delay(
            Math.max(0, Number.isFinite(wait) ? wait : 1000),
            undefined,
            { signal: this.signal },
          );
          continue;
        }
        return response;
      }
    });
  }
  private async boundedResponse(
    response: Response,
    readOnly: boolean,
    graphql: boolean,
  ) {
    // These responses are consumed by the rate-limit path, not Octokit. Record
    // the cooldown without waiting for a potentially large error body.
    if (
      response.status === 429 ||
      (response.status === 403 &&
        (response.headers.has("retry-after") ||
          response.headers.get("x-ratelimit-remaining") === "0"))
    )
      return response;
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new ServiceError(
        "redirect",
        "GitHub API 返回重定向，请检查站点地址和目标；未转发凭据",
      );
    }
    // Bound Octokit's otherwise unbounded JSON/text decoder, including error bodies.
    if (Number(response.headers.get("content-length")) > MAX_RESPONSE) {
      await response.body?.cancel();
      throw new ServiceError(
        readOnly ? "result_too_large" : "unknown",
        "GitHub 响应超过 24 MiB，请缩小查询范围或下载文件；不要重复写入",
      );
    }
    if (!response.body) return response;
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.length;
        if (size > MAX_RESPONSE)
          throw new ServiceError(
            readOnly ? "result_too_large" : "unknown",
            "GitHub 响应超过 24 MiB",
          );
        chunks.push(item.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const bytes = Buffer.concat(chunks);
    // Inspect the bounded body before releasing the queue slot. A secondary
    // limit may appear only in a REST 403 body or a GraphQL 200 error envelope.
    if (response.status === 403 || graphql) {
      try {
        const data = JSON.parse(bytes.toString("utf8"));
        if (
          (response.status === 403 &&
            typeof data?.message === "string" &&
            /rate limit|abuse/i.test(data.message)) ||
          (graphql &&
            Array.isArray(data?.errors) &&
            data.errors.some(
              (error: Json) =>
                (error.type ?? error.extensions?.code) === "RATE_LIMITED",
            ))
        )
          this.gate.recordLimit(response.headers);
      } catch {
        /* Octokit reports malformed bodies through the existing error path. */
      }
    }
    return new Response(bytes, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  async rest(
    route: string,
    params: Json = {},
    readOnly = route.startsWith("GET ") || route.startsWith("HEAD "),
    graphql = false,
  ): Promise<{
    data: any;
    headers: Record<string, string | undefined>;
    status: number;
  }> {
    return trackToolTask(async () => {
      const guardedFetch: typeof fetch = (input, init) =>
        this.request(String(input), init ?? {}, readOnly, false, true);
      const client = new Octokit({
        auth: this.connection.token,
        baseUrl: this.addresses.rest,
        userAgent: "WorkLens",
        retry: { enabled: false },
        throttle: { enabled: false },
        request: { fetch: guardedFetch },
        log: { debug() {}, info() {}, warn() {}, error() {} },
      });
      try {
        const result = await client.request(route as any, {
          ...params,
          ...(graphql ? { url: this.addresses.graphql } : {}),
          headers: {
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
            ...params.headers,
          },
          request: { signal: this.signal },
        });
        return {
          ...result,
          data:
            result.data === undefined
              ? undefined
              : JSON.parse(
                  JSON.stringify(result.data, (_key, value) =>
                    typeof value === "bigint" ? value.toString() : value,
                  ),
                ),
        };
      } catch (e) {
        if (e instanceof ServiceError) throw e;
        if (e instanceof Error && e.cause instanceof ServiceError)
          throw e.cause;
        const error = e as {
          status?: number;
          response?: { data?: Json; headers?: Json };
        };
        if (!error.status || !error.response) {
          if (readOnly) this.signal.throwIfAborted();
          throw new ServiceError(
            readOnly ? "network" : "unknown",
            "GitHub 请求失败，写入结果需要核实",
          );
        }
        const status = error.status;
        const message =
          typeof error.response?.data?.message === "string"
            ? error.response.data.message.slice(0, 1500)
            : "";
        const limited =
          status === 429 ||
          (status === 403 &&
            (/rate limit|abuse/i.test(message) ||
              error.response?.headers?.["x-ratelimit-remaining"] === "0"));
        if (limited) {
          const headers = new Headers();
          for (const [key, value] of Object.entries(
            error.response.headers ?? {},
          ))
            if (typeof value === "string") headers.set(key, value);
          throw this.rateLimit(this.gate.recordLimit(headers));
        }
        const code = limited
          ? "rate_limit"
          : status === 401
            ? "authentication"
            : status === 403
              ? "permission"
              : status === 404
                ? "not_found_or_forbidden"
                : [409, 412].includes(status)
                  ? "conflict"
                  : status === 422
                    ? "invalid_request"
                    : status >= 500 && !readOnly
                      ? "unknown"
                      : status >= 300 && status < 400
                        ? "redirect"
                        : "http";
        throw new ServiceError(code, `GitHub 返回 ${status}。${message}`, {
          status,
        });
      }
    });
  }
  async graphql(query: string, variables: Json, write = false) {
    return trackToolTask(async () => {
      const response = await this.rest(
        "POST /graphql",
        { query, variables },
        !write,
        true,
      );
      if (response.data.errors?.length) {
        const errors = response.data.errors.map((e: Json) => ({
          message: e.message,
          type: e.type ?? e.extensions?.code,
          path: e.path,
        }));
        const unsupported = errors.every((e: Json) =>
          /undefinedField|undefinedType|argumentNotAccepted/.test(e.type),
        );
        if (errors.some((e: Json) => e.type === "RATE_LIMITED")) {
          const headers = new Headers();
          for (const [key, value] of Object.entries(response.headers))
            if (value !== undefined) headers.set(key, value);
          this.gate.recordLimit(headers);
        }
        throw new ServiceError(
          unsupported
            ? "unsupported_capability"
            : response.data.data
              ? "partial"
              : errors.some((e: Json) => e.type === "RATE_LIMITED")
                ? "rate_limit"
                : errors.some((e: Json) => e.type === "FORBIDDEN")
                  ? "permission"
                  : errors.some((e: Json) => e.type === "NOT_FOUND")
                    ? "not_found_or_forbidden"
                    : "graphql",
          "GitHub GraphQL 未完整执行请求",
          { errors, data: response.data.data },
        );
      }
      return response.data.data;
    });
  }
  async download(
    route: string,
    params: Json,
    accept = "application/octet-stream",
  ) {
    return trackToolTask(async () => {
      // Use Octokit's route expansion, but stream the actual response to LocalArtifacts.
      const endpoint = new Octokit({
        baseUrl: this.addresses.rest,
      }).request.endpoint(route as any, params);
      let currentUrl = endpoint.url;
      let response = await this.request(
        currentUrl,
        {
          headers: {
            Authorization: `Bearer ${this.connection.token}`,
            Accept: accept,
          },
        },
        true,
      );
      for (
        let redirects = 0;
        [301, 302, 303, 307, 308].includes(response.status);
        redirects++
      ) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (redirects >= 4 || !location)
          throw new ServiceError("redirect", "下载重定向无效");
        const target = new URL(location, currentUrl);
        if (target.protocol !== "https:" || target.username || target.password)
          throw new ServiceError(
            "invalid_target",
            "下载仅允许不含凭据的 HTTPS 跳转",
          );
        currentUrl = target.href;
        response = await this.fetcher(target, {
          redirect: "manual",
          signal: this.signal,
        });
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new ServiceError(
          "download",
          `GitHub 下载失败 (${response.status})`,
        );
      }
      return response;
    });
  }
  async upload(
    path: string,
    name: string,
    bytes: Uint8Array,
    contentType: string,
  ) {
    return trackToolTask(async () => {
      const url = `${this.addresses.uploads}${path}?name=${encodeURIComponent(name)}`;
      const response = await this.request(
        url,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.connection.token}`,
            "Content-Type": contentType,
          },
          body: Buffer.from(bytes),
        },
        false,
        true,
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new ServiceError(
          response.status >= 500 ? "unknown" : "upload",
          `GitHub 上传失败 (${response.status})`,
        );
      }
      return response.json();
    });
  }
}
