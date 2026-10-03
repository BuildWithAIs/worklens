import { createHash, randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { z } from "zod";
import { atomicJson, SerialQueue, type Encryption } from "../../storage";
import type {
  TavilyConnection,
  TavilySettingsInput,
  TavilyUsageState,
} from "../../../shared/contracts";
import { ServiceError, TavilyHttp, type Json } from "./http";
import { accountUsage } from "./usage";

// The form's generic credential field is `token`; Tavily calls it an API key.
// The address is editable so a proxy or self-hosted gateway can stand in.
export const connectionSchema = z
  .object({
    url: z.string().trim().min(1, "请填写 Tavily API 地址").max(2000),
    token: z.string().trim().max(500).optional(),
  })
  .strict();
export function normalizeSettings(
  raw: TavilySettingsInput,
): TavilySettingsInput {
  const input = connectionSchema.parse(raw);
  const url = new URL(input.url);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("请输入不含凭据、查询参数或片段的 Tavily API 地址");
  return { ...input, url: url.href.replace(/\/+$/, "") };
}
export interface ConnectionSnapshot {
  settings: TavilyConnection;
  token: string;
  revision: string;
  signal: AbortSignal;
}
const USAGE_CACHE_MS = 5 * 60_000;
const USAGE_REFRESH_MS = 60_000;
interface UsageResponse {
  data: Json;
  fetchedAt: number;
  expiresAt: number;
}
interface UsageRequest {
  data?: UsageResponse;
  expiresAt: number;
  pending?: Promise<UsageResponse>;
  signal?: AbortSignal;
  error?: unknown;
  retryAt: number;
}
export class TavilyConnections {
  private value: TavilyConnection = { url: "", configured: false };
  private token = "";
  private revision = randomUUID();
  private controller = new AbortController();
  private queue = new SerialQueue();
  private secrets = new Set<string>();
  private usageRequests = new Map<string, UsageRequest>();
  constructor(
    private path: string,
    private encryption: Encryption,
    readonly fetcher: typeof fetch = fetch,
  ) {}
  private remember(token: string) {
    if (token)
      for (const value of [
        token,
        encodeURIComponent(token),
        Buffer.from(token).toString("base64"),
      ])
        this.secrets.add(value);
  }
  redact(text: string) {
    for (const secret of [...this.secrets].sort((a, b) => b.length - a.length))
      text = text
        .split(secret)
        .join("[redacted]")
        .split(JSON.stringify(secret).slice(1, -1))
        .join("[redacted]");
    return text;
  }
  info(): TavilyConnection {
    return { ...this.value };
  }
  configurationKey() {
    return JSON.stringify([this.revision, this.value]);
  }
  private candidate(raw: TavilySettingsInput): ConnectionSnapshot {
    const input = normalizeSettings(raw);
    const token =
      input.token || (input.url === this.value.url ? this.token : "");
    if (!token)
      throw new Error("请填写 Tavily API key；更换地址后需要重新填写");
    this.remember(token);
    return {
      settings: { url: input.url, configured: false },
      token,
      revision: this.revision,
      signal: this.controller.signal,
    };
  }
  // /usage allows only 10 requests per 10 minutes. Share successful validation
  // responses with the UI, coalesce mounts, and honor server cooldowns across
  // both usage reads and explicit connection tests. Explicit tests stay live.
  private async requestUsage(
    snapshot: ConnectionSnapshot,
    fresh = false,
    timeoutMs = 15_000,
  ) {
    snapshot.signal.throwIfAborted();
    const now = Date.now();
    const key = this.usageKey(snapshot);
    for (const [otherKey, entry] of this.usageRequests) {
      if (
        otherKey !== key &&
        !entry.pending &&
        entry.expiresAt <= now &&
        entry.retryAt <= now
      )
        this.usageRequests.delete(otherKey);
    }
    let entry = this.usageRequests.get(key);
    if (!entry) {
      entry = { expiresAt: 0, retryAt: 0 };
      this.usageRequests.set(key, entry);
    }
    if (!fresh && entry.data && entry.expiresAt > now) return entry.data;
    if (
      entry.retryAt > now &&
      (!fresh ||
        (entry.error instanceof ServiceError &&
          entry.error.code === "rate_limit"))
    )
      throw entry.error;
    if (entry.pending && !entry.signal?.aborted) return entry.pending;
    const current = entry;
    current.signal = snapshot.signal;
    const pending = (async () => {
      try {
        const data = await new TavilyHttp(
          snapshot,
          this.fetcher,
          AbortSignal.timeout(timeoutMs),
        ).request("GET", "/usage");
        snapshot.signal.throwIfAborted();
        if (typeof data.account?.current_plan !== "string" || !data.key)
          throw new Error("Tavily 未返回有效的账号信息");
        const fetchedAt = Date.now();
        current.expiresAt = fetchedAt + USAGE_CACHE_MS;
        current.data = { data, fetchedAt, expiresAt: current.expiresAt };
        current.retryAt = 0;
        current.error = undefined;
        return current.data;
      } catch (error) {
        if (!snapshot.signal.aborted) {
          const retryAfter =
            error instanceof ServiceError && error.code === "rate_limit"
              ? (error.data as { retryAfterMs: number }).retryAfterMs
              : 60_000;
          current.error = error;
          current.retryAt = Date.now() + retryAfter;
        }
        throw error;
      } finally {
        if (current.signal === snapshot.signal) current.pending = undefined;
      }
    })();
    current.pending = pending;
    return pending;
  }
  /** `GET /usage` verifies the key without spending search credits. */
  private async validate(snapshot: ConnectionSnapshot) {
    const { data: usage } = await this.requestUsage(snapshot, true, 120_000);
    const plan = usage.account?.current_plan;
    snapshot.settings.plan = plan;
    snapshot.settings.configured = true;
    return `Tavily 已连接：${plan}`;
  }
  async test(input: TavilySettingsInput) {
    try {
      return await this.validate(this.candidate(input));
    } catch (e) {
      throw new Error(this.redact(e instanceof Error ? e.message : String(e)));
    }
  }
  private usageKey(snapshot: ConnectionSnapshot) {
    return createHash("sha256")
      .update(JSON.stringify([snapshot.settings.url, snapshot.token]))
      .digest("hex");
  }
  async usage(refresh = false) {
    try {
      const snapshot = this.snapshot();
      const cached = this.usageRequests.get(this.usageKey(snapshot));
      const fresh =
        refresh &&
        (!cached?.data ||
          Date.now() >= cached.data.fetchedAt + USAGE_REFRESH_MS);
      const { data, fetchedAt, expiresAt } = await this.requestUsage(
        snapshot,
        fresh,
      );
      snapshot.signal.throwIfAborted();
      // A read must not alter credentials or invalidate running agent contexts.
      return { ...accountUsage(data), fetchedAt, expiresAt };
    } catch (error) {
      throw new Error(
        this.redact(error instanceof Error ? error.message : String(error)),
      );
    }
  }
  async usageState(refresh = false): Promise<TavilyUsageState> {
    const snapshot = this.snapshot();
    const key = this.usageKey(snapshot);
    try {
      const usage = await this.usage(refresh);
      const cached = this.usageRequests.get(key);
      return {
        usage,
        refreshAfter: Math.max(
          usage.fetchedAt + USAGE_REFRESH_MS,
          cached?.retryAt ?? 0,
        ),
        ...(cached?.error
          ? {
              error:
                cached.error instanceof ServiceError &&
                cached.error.code === "rate_limit"
                  ? ("rate_limit" as const)
                  : ("unavailable" as const),
            }
          : {}),
      };
    } catch {
      snapshot.signal.throwIfAborted();
      const cached = this.usageRequests.get(key);
      return {
        ...(cached?.data
          ? {
              usage: {
                ...accountUsage(cached.data.data),
                fetchedAt: cached.data.fetchedAt,
                expiresAt: cached.data.expiresAt,
              },
            }
          : {}),
        refreshAfter: cached?.retryAt || Date.now() + USAGE_REFRESH_MS,
        error:
          cached?.error instanceof ServiceError &&
          cached.error.code === "rate_limit"
            ? "rate_limit"
            : "unavailable",
      };
    }
  }
  async load() {
    try {
      const data = JSON.parse(await readFile(this.path, "utf8"));
      if (
        data.version !== 1 ||
        !z.uuid().safeParse(data.revision).success ||
        typeof data.encrypted !== "string"
      )
        throw new Error("Invalid credentials");
      const settings = normalizeSettings({ url: data.settings.url });
      this.value = { url: settings.url, configured: false };
      this.token = this.encryption.decryptString(
        Buffer.from(data.encrypted, "base64"),
      );
      this.remember(this.token);
      this.revision = data.revision;
      const next = this.candidate(settings);
      try {
        await this.validate(next);
        this.value = next.settings;
      } catch (e) {
        this.value.error = this.redact(
          e instanceof Error ? e.message : String(e),
        );
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        this.value.error =
          "无法读取或解密 Tavily 配置，原文件已保留。请重新填写 token 或断开连接。";
    }
  }
  snapshot(): ConnectionSnapshot {
    if (!this.value.configured || !this.token)
      throw new Error("请先在设置 → 连接中保存并验证 Tavily 连接");
    return {
      settings: this.info(),
      token: this.token,
      revision: this.revision,
      signal: this.controller.signal,
    };
  }
  save(input: TavilySettingsInput) {
    return this.queue.run("connection", async () => {
      this.controller.abort();
      this.controller = new AbortController();
      this.value.configured = false;
      const next = this.candidate(input);
      if (!this.encryption.isEncryptionAvailable())
        throw new Error("操作系统安全存储不可用，无法保存凭据");
      try {
        await this.validate(next);
      } catch (e) {
        next.settings.error = this.redact(
          e instanceof Error ? e.message : String(e),
        );
      }
      const revision =
        next.settings.url === this.value.url && next.token === this.token
          ? this.revision
          : randomUUID();
      await atomicJson(this.path, {
        version: 1,
        revision,
        settings: next.settings,
        encrypted: this.encryption.encryptString(next.token).toString("base64"),
      });
      this.controller.abort();
      this.controller = new AbortController();
      this.revision = revision;
      this.value = next.settings;
      this.token = next.token;
      if (this.value.error) throw new Error(this.value.error);
      return this.info();
    });
  }
  remove() {
    return this.queue.run("connection", async () => {
      await unlink(this.path).catch((e) => {
        if (e.code !== "ENOENT") throw e;
      });
      this.controller.abort();
      this.controller = new AbortController();
      this.revision = randomUUID();
      this.token = "";
      // Disconnecting clears account data, but must not bypass a server cooldown
      // if the user reconnects the same key immediately.
      for (const entry of this.usageRequests.values()) {
        entry.data = undefined;
        entry.expiresAt = 0;
      }
      this.value = { url: "", configured: false };
    });
  }
}
