import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { z } from "zod";
import { atomicJson, SerialQueue, type Encryption } from "../../storage";
import type {
  GitHubConnection,
  GitHubSettingsInput,
} from "../../../shared/contracts";
import { GitHubHttp } from "./http";

export const connectionSchema = z
  .object({
    url: z.string().trim().min(1, "请填写 GitHub 地址").max(2000),
    token: z.string().trim().max(20000).optional(),
  })
  .strict();
export function normalizeSettings(
  raw: GitHubSettingsInput,
): GitHubSettingsInput {
  const input = connectionSchema.parse(raw);
  const url = new URL(input.url);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/*$/.test(url.pathname)
  )
    throw new Error(
      "请输入 GitHub 站点根地址，不包含仓库路径、凭据、查询参数或片段",
    );
  if (
    (url.hostname === "github.com" || url.hostname.endsWith(".ghe.com")) &&
    (url.protocol !== "https:" || url.port)
  )
    throw new Error("GitHub Cloud 需要标准 HTTPS 站点地址");
  return { ...input, url: url.origin };
}
export function apiAddresses(site: string) {
  const url = new URL(site);
  if (url.hostname === "github.com")
    return {
      rest: "https://api.github.com",
      graphql: "https://api.github.com/graphql",
      uploads: "https://uploads.github.com",
    };
  if (/^[a-z0-9-]+\.ghe\.com$/.test(url.hostname)) {
    const api = `https://api.${url.hostname}`;
    return {
      rest: api,
      graphql: `${api}/graphql`,
      uploads: `https://uploads.${url.hostname}`,
    };
  }
  return {
    rest: `${site}/api/v3`,
    graphql: `${site}/api/graphql`,
    uploads: `${site}/api/uploads`,
  };
}
export interface ConnectionSnapshot {
  settings: GitHubConnection;
  token: string;
  revision: string;
  signal: AbortSignal;
}
export class GitHubConnections {
  private value: GitHubConnection = { url: "", configured: false };
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
  info(): GitHubConnection {
    return { ...this.value };
  }
  configurationKey() {
    return JSON.stringify([this.revision, this.value]);
  }
  private candidate(raw: GitHubSettingsInput): ConnectionSnapshot {
    const input = normalizeSettings(raw);
    const token =
      input.token || (input.url === this.value.url ? this.token : "");
    if (!token) throw new Error("请填写 token；更换站点后需要重新填写");
    this.remember(token);
    return {
      settings: { url: input.url, configured: false },
      token,
      revision: this.revision,
      signal: this.controller.signal,
    };
  }
  private async validate(snapshot: ConnectionSnapshot) {
    const response = await new GitHubHttp(snapshot, this.fetcher).rest(
      "GET /user",
    );
    if (
      !response.data ||
      typeof response.data.login !== "string" ||
      typeof response.data.id !== "number"
    )
      throw new Error("GitHub 未返回有效的认证账号");
    snapshot.settings.login = response.data.login;
    snapshot.settings.serverVersion =
      response.headers["x-github-enterprise-version"];
    snapshot.settings.configured = true;
    return `GitHub 已连接：${response.data.login}${snapshot.settings.serverVersion ? ` (Enterprise ${snapshot.settings.serverVersion})` : ""}`;
  }
  async test(input: GitHubSettingsInput) {
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
          "无法读取或解密 GitHub 配置，原文件已保留。请重新填写 token 或断开连接。";
    }
  }
  snapshot(): ConnectionSnapshot {
    if (!this.value.configured || !this.token)
      throw new Error("请先在设置 → 连接中保存并验证 GitHub 连接");
    return {
      settings: this.info(),
      token: this.token,
      revision: this.revision,
      signal: this.controller.signal,
    };
  }
  assertCurrent(snapshot: ConnectionSnapshot) {
    snapshot.signal.throwIfAborted();
    if (snapshot.revision !== this.revision)
      throw new Error("GitHub 连接已变更，请重新读取目标");
  }
  save(input: GitHubSettingsInput) {
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
