import { setTimeout as delay } from "node:timers/promises";
import type { ConnectionSnapshot } from "./connection";
export class ServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}
export type Json = Record<string, any>;
export class ConfluenceHttp {
  readonly base: string;
  readonly site: URL;
  readonly signal: AbortSignal;
  constructor(
    readonly connection: ConnectionSnapshot,
    signal?: AbortSignal,
    private fetcher: typeof fetch = fetch,
  ) {
    const s = connection.settings;
    this.site = new URL(s.url + "/");
    this.base =
      s.deployment === "cloud" && s.tokenType === "scoped"
        ? `https://api.atlassian.com/ex/confluence/${s.cloudId}/wiki`
        : s.url;
    this.signal = AbortSignal.any([
      connection.signal,
      ...(signal ? [signal] : []),
      AbortSignal.timeout(180_000),
    ]);
  }
  url(path: string) {
    return this.base + path;
  }
  pageId(target: string) {
    if (/^\d+$/.test(target)) return target;
    const u = new URL(target);
    const sitePath = this.site.pathname.replace(/\/$/, "");
    if (
      u.origin !== this.site.origin ||
      (sitePath &&
        u.pathname !== sitePath &&
        !u.pathname.startsWith(sitePath + "/"))
    )
      throw new ServiceError(
        "invalid_target",
        "页面 URL 不属于已配置的 Confluence 站点",
      );
    const id =
      u.searchParams.get("pageId") ||
      u.pathname.match(/\/(?:pages|content)\/(\d+)(?:\/|$)/)?.[1];
    if (!id || !/^\d+$/.test(id))
      throw new ServiceError(
        "invalid_target",
        "无法解析页面 ID，请使用 pageId 链接或数字 ID",
      );
    return id;
  }
  webUrl(value?: string, id?: string) {
    if (!value)
      return `${this.connection.settings.url}/pages/viewpage.action?pageId=${id}`;
    const context = this.site.pathname.replace(/\/$/, "");
    return new URL(
      value.startsWith("/")
        ? (context && !value.startsWith(context + "/")
            ? this.connection.settings.url
            : this.site.origin) + value
        : value,
      this.site,
    ).href;
  }
  private trusted(url: URL) {
    const base = new URL(this.base + "/");
    return url.origin === base.origin && url.pathname.startsWith(base.pathname);
  }
  nextPath(value: string) {
    if (
      this.connection.settings.tokenType === "scoped" &&
      value.startsWith("/wiki/")
    )
      value = this.base + value.slice(5);
    const url = new URL(value, this.base + "/");
    if (!this.trusted(url) || !url.pathname.includes("/api/"))
      throw new ServiceError(
        "invalid_continuation",
        "服务返回了不属于此连接的分页链接",
      );
    return (
      url.pathname.slice(
        new URL(this.base).pathname.replace(/\/$/, "").length,
      ) + url.search
    );
  }
  async request(
    path: string,
    method = "GET",
    body?: unknown,
    allowDownloadRedirect = false,
  ): Promise<Response> {
    const url = new URL(this.url(path));
    if (!this.trusted(url))
      throw new ServiceError("invalid_target", "请求超出 Confluence API 范围");
    const { settings, token } = this.connection;
    const authorization =
      settings.deployment === "cloud"
        ? `Basic ${Buffer.from(`${settings.email}:${token}`).toString("base64")}`
        : `Bearer ${token}`;
    const form = body instanceof FormData;
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: authorization,
    };
    if (form) headers["X-Atlassian-Token"] = "nocheck";
    else if (body !== undefined) headers["Content-Type"] = "application/json";
    for (let attempt = 0; ; attempt++) {
      this.signal.throwIfAborted();
      let response: Response;
      try {
        response = await this.fetcher(url, {
          method,
          headers,
          body: form
            ? body
            : body === undefined
              ? undefined
              : JSON.stringify(body),
          redirect: "manual",
          signal: AbortSignal.any([this.signal, AbortSignal.timeout(30_000)]),
        });
      } catch {
        if (method !== "GET")
          throw new ServiceError(
            "unknown",
            "请求已发出，但无法确认写入结果。请读取目标核实，不要重复提交。",
          );
        this.signal.throwIfAborted();
        if (attempt >= 2)
          throw new ServiceError("network", "Confluence 网络请求失败或超时");
        await delay(500 * 2 ** attempt, undefined, { signal: this.signal });
        continue;
      }
      if (
        method === "GET" &&
        [429, 500, 502, 503, 504].includes(response.status) &&
        attempt < 2
      ) {
        const header = response.headers.get("retry-after");
        const ms = header
          ? /^\d+(\.\d+)?$/.test(header)
            ? Number(header) * 1000
            : Date.parse(header) - Date.now()
          : 500 * 2 ** attempt;
        await response.body?.cancel();
        if (ms > 30_000)
          throw new ServiceError(
            "rate_limit",
            `服务要求稍后重试（${header}）`,
            429,
          );
        await delay(Math.max(0, Number.isFinite(ms) ? ms : 1000), undefined, {
          signal: this.signal,
        });
        continue;
      }
      if (
        allowDownloadRedirect &&
        [301, 302, 303, 307, 308].includes(response.status)
      )
        return response;
      if (!response.ok) {
        await response.body?.cancel();
        const code =
          response.status === 401
            ? "authentication"
            : response.status === 403
              ? "permission"
              : response.status === 404
                ? "not_found_or_forbidden"
                : response.status === 409
                  ? "conflict"
                  : response.status === 429
                    ? "rate_limit"
                    : response.status >= 500 && method !== "GET"
                      ? "unknown"
                      : "http";
        throw new ServiceError(
          code,
          `Confluence 返回 ${response.status}。${code === "conflict" ? "页面已变更，请重新读取并准备修改。" : code === "unknown" ? "写入结果不确定，请先核实。" : response.status >= 300 && response.status < 400 ? "检测到重定向，请检查站点地址及 API 认证，不能使用网页登录地址。" : "请检查目标、部署类型、token 和权限。"}`,
          response.status,
        );
      }
      return response;
    }
  }
  async json(path: string, method = "GET", body?: unknown): Promise<Json> {
    const response = await this.request(path, method, body);
    return this.decode(response, method);
  }
  async decode(response: Response, method = "GET"): Promise<Json> {
    if (response.status === 204) return {};
    try {
      if (!(response.headers.get("content-type") ?? "").includes("json"))
        throw new Error("Expected JSON");
      const reader = response.body!.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 16 * 1024 * 1024) throw new Error("Response too large");
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      const data = JSON.parse(Buffer.concat(chunks).toString());
      if (!data || typeof data !== "object")
        throw new Error("Invalid response");
      return data;
    } catch {
      throw new ServiceError(
        method === "GET" ? "invalid_response" : "unknown",
        method === "GET"
          ? "服务未返回可用的 JSON（可能是 SSO 登录页面或响应过大）"
          : "写入返回内容不可解析，结果不确定，请先核实目标",
      );
    }
  }
  async download(path: string): Promise<Response> {
    // Only an attachment endpoint resolved by the adapter can enter here.
    let response = await this.request(path, "GET", undefined, true);
    let current = new URL(this.url(path));
    for (let hop = 0; hop < 5; hop++) {
      if (response.ok) return response;
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location)
        throw new ServiceError("invalid_redirect", "附件下载重定向缺少地址");
      current = new URL(location, current);
      if (current.protocol !== "https:" || current.username || current.password)
        throw new ServiceError("invalid_redirect", "拒绝不安全的附件重定向");
      // Signed download URLs may point to a CDN. Never forward the API credential.
      response = await this.fetcher(current, {
        redirect: "manual",
        signal: this.signal,
      });
      if (
        !response.ok &&
        ![301, 302, 303, 307, 308].includes(response.status)
      ) {
        await response.body?.cancel();
        throw new ServiceError(
          "download_failed",
          `附件下载失败（${response.status}）`,
        );
      }
    }
    await response.body?.cancel();
    throw new ServiceError("invalid_redirect", "附件重定向次数过多");
  }
}

export class ReadLimiter {
  private active = 0;
  private waiting: {
    enter: () => void;
    reject: (error: unknown) => void;
    signal: AbortSignal;
    abort: () => void;
  }[] = [];
  constructor(private maximum = 4) {}
  async run<T>(signal: AbortSignal, execute: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    if (this.active < this.maximum) this.active++;
    else
      await new Promise<void>((resolve, reject) => {
        const waiter = {
          enter: resolve,
          reject,
          signal,
          abort: () => {
            const index = this.waiting.indexOf(waiter);
            if (index >= 0) this.waiting.splice(index, 1);
            reject(signal.reason);
          },
        };
        this.waiting.push(waiter);
        signal.addEventListener("abort", waiter.abort, { once: true });
      });
    try {
      signal.throwIfAborted();
      return await execute();
    } finally {
      const waiter = this.waiting.shift();
      if (waiter) {
        waiter.signal.removeEventListener("abort", waiter.abort);
        waiter.enter();
      } else this.active--;
    }
  }
}
