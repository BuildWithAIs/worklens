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
export class JiraHttp {
  readonly base: string;
  readonly site: URL;
  readonly signal: AbortSignal;
  constructor(
    readonly connection: ConnectionSnapshot,
    signal?: AbortSignal,
    private fetcher: typeof fetch = fetch,
    timeoutMs = 180_000,
  ) {
    const s = connection.settings;
    this.site = new URL(s.url + "/");
    this.base =
      s.deployment === "cloud" && s.tokenType === "scoped"
        ? `https://api.atlassian.com/ex/jira/${s.cloudId}`
        : s.url;
    this.signal = AbortSignal.any([
      connection.signal,
      ...(signal ? [signal] : []),
      AbortSignal.timeout(timeoutMs),
    ]);
  }
  url(path: string) {
    return this.base + path;
  }
  issueId(target: string) {
    if (/^(?:[A-Z][A-Z0-9_]*-\d+|\d+)$/i.test(target))
      return target.toUpperCase();
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      throw new ServiceError(
        "invalid_target",
        "请输入工单 key、数字 ID 或本站工单 URL",
      );
    }
    const prefix = this.site.pathname.replace(/\/$/, "");
    if (
      url.origin !== this.site.origin ||
      url.username ||
      url.password ||
      !url.pathname.startsWith(prefix + "/")
    )
      throw new ServiceError("invalid_target", "工单 URL 不属于当前 Jira 站点");
    const key =
      url.pathname.match(/\/browse\/([A-Z][A-Z0-9_]*-\d+)\/?$/i)?.[1] ??
      url.searchParams.get("selectedIssue");
    if (!key || !/^[A-Z][A-Z0-9_]*-\d+$/i.test(key))
      throw new ServiceError("invalid_target", "无法解析工单 key");
    return key.toUpperCase();
  }
  webUrl(key: string) {
    return this.connection.settings.url + "/browse/" + encodeURIComponent(key);
  }
  private trusted(url: URL) {
    const base = new URL(this.base + "/");
    return url.origin === base.origin && url.pathname.startsWith(base.pathname);
  }
  async request(
    path: string,
    method = "GET",
    body?: unknown,
    allowDownloadRedirect = false,
    readOnly = method === "GET",
  ): Promise<Response> {
    const url = new URL(this.url(path));
    if (!this.trusted(url))
      throw new ServiceError("invalid_target", "请求超出 Jira API 范围");
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
    if (form) headers["X-Atlassian-Token"] = "no-check";
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
        if (!readOnly)
          throw new ServiceError(
            "unknown",
            "请求已发出，但无法确认写入结果。请读取目标核实，不要重复提交。",
          );
        this.signal.throwIfAborted();
        if (attempt >= 2)
          throw new ServiceError("network", "Jira 网络请求失败或超时");
        await delay(500 * 2 ** attempt, undefined, { signal: this.signal });
        continue;
      }
      if (
        readOnly &&
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
        let detail = "";
        if (response.status === 400) {
          try {
            detail = JSON.stringify(await this.decode(response)).slice(0, 3000);
          } catch {}
        } else await response.body?.cancel();
        const code =
          response.status === 400
            ? "invalid_request"
            : response.status === 401
              ? "authentication"
              : response.status === 403
                ? "permission"
                : response.status === 404
                  ? "not_found_or_forbidden"
                  : response.status === 409
                    ? "conflict"
                    : response.status === 429
                      ? "rate_limit"
                      : response.status >= 500 && !readOnly
                        ? "unknown"
                        : "http";
        throw new ServiceError(
          code,
          `Jira 返回 ${response.status}。${detail} ${code === "conflict" ? "页面已变更，请重新读取并准备修改。" : code === "unknown" ? "写入结果不确定，请先核实。" : response.status >= 300 && response.status < 400 ? "检测到重定向，请检查站点地址及 API 认证，不能使用网页登录地址。" : "请检查目标、部署类型、token 和权限。"}`,
          response.status,
        );
      }
      return response;
    }
  }
  async json(
    path: string,
    method = "GET",
    body?: unknown,
    readOnly = method === "GET",
  ): Promise<Json> {
    const response = await this.request(path, method, body, false, readOnly);
    return this.decode(response, readOnly ? "GET" : method);
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
