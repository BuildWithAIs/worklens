import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { z } from "zod";
import { atomicJson, SerialQueue, type Encryption } from "../../storage";
import type {
  TavilyConnection,
  TavilySettingsInput,
} from "../../../shared/contracts";
import { TavilyHttp } from "./http";

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
export class TavilyConnections {
  private value: TavilyConnection = { url: "", configured: false };
  private token = "";
  private revision = randomUUID();
  private controller = new AbortController();
  private queue = new SerialQueue();
  private secrets = new Set<string>();
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
  /** `GET /usage` verifies the key without spending search credits. */
  private async validate(snapshot: ConnectionSnapshot) {
    const usage = await new TavilyHttp(snapshot, this.fetcher).request(
      "GET",
      "/usage",
    );
    const plan = usage.account?.current_plan;
    if (typeof plan !== "string" || !usage.key)
      throw new Error("Tavily 未返回有效的账号信息");
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
      const revision = randomUUID();
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
      this.value = { url: "", configured: false };
    });
  }
}
