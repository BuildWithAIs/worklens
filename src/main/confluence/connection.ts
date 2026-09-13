import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { z } from "zod";
import { atomicJson, SerialQueue, type Encryption } from "../storage";
import type {
  ConfluenceConnection,
  ConfluenceSettingsInput,
} from "../../shared/contracts";

export const connectionSchema = z
  .object({
    url: z.string().trim().min(1).max(2000),
    deployment: z.enum(["data-center", "cloud"]),
    email: z.string().trim().max(320).optional(),
    token: z.string().trim().max(20000).optional(),
    cloudId: z
      .string()
      .trim()
      .max(100)
      .regex(/^[a-zA-Z0-9-]*$/)
      .optional(),
    tokenType: z.enum(["classic", "scoped"]),
  })
  .strict();
export interface ConnectionSnapshot {
  settings: ConfluenceConnection;
  token: string;
  revision: string;
  signal: AbortSignal;
}
export function normalizeSettings(
  raw: ConfluenceSettingsInput,
): ConfluenceSettingsInput {
  const input = connectionSchema.parse(raw);
  const url = new URL(input.url);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("请输入不含凭据、查询参数或片段的 Confluence 站点地址");
  // HTTP remains available for explicitly configured intranet deployments.
  if (input.deployment === "cloud") {
    if (url.protocol !== "https:") throw new Error("Cloud 需要 HTTPS 地址");
    if (!input.email || !z.email().safeParse(input.email).success)
      throw new Error("Cloud 需要 Atlassian 账户邮箱");
    if (input.tokenType === "scoped" && !input.cloudId)
      throw new Error("Scoped token 需要站点 Cloud ID");
    if (!url.pathname.replace(/\/+$/, "")) url.pathname = "/wiki";
  }
  return { ...input, url: url.href.replace(/\/+$/, "") };
}
const empty: ConfluenceConnection = {
  url: "",
  deployment: "data-center",
  tokenType: "classic",
  configured: false,
};
export class ConfluenceConnections {
  private value = { ...empty };
  private token = "";
  private revision = randomUUID();
  private controller = new AbortController();
  private queue = new SerialQueue();
  private secrets = new Set<string>();
  constructor(
    private path: string,
    private encryption: Encryption,
  ) {}
  private remember(token: string, email?: string) {
    if (token) {
      this.secrets.add(token);
      this.secrets.add(
        Buffer.from(`${email ?? ""}:${token}`).toString("base64"),
      );
    }
  }
  redact(text: string) {
    for (const secret of [...this.secrets].sort(
      (a, b) => b.length - a.length,
    )) {
      text = text.split(secret).join("[redacted]");
      text = text.split(JSON.stringify(secret).slice(1, -1)).join("[redacted]");
    }
    return text;
  }
  async load() {
    try {
      const data = JSON.parse(await readFile(this.path, "utf8"));
      const {
        configured: _configured,
        error: _error,
        access: _legacyAccess,
        ...storedSettings
      } = data.settings;
      const { token: _ignored, ...settings } =
        normalizeSettings(storedSettings);
      this.value = { ...settings, configured: false };
      if (data.version !== 1 || typeof data.encrypted !== "string")
        throw new Error("Invalid credentials");
      const token = this.encryption.decryptString(
        Buffer.from(data.encrypted, "base64"),
      );
      if (!token) throw new Error("Empty token");
      // Upgrade the original v1 file before issuing persistent cursors. Preserve ciphertext.
      const revision = data.revision ?? randomUUID();
      if (!z.uuid().safeParse(revision).success)
        throw new Error("Invalid connection revision");
      if (data.revision === undefined || "access" in data.settings)
        await atomicJson(this.path, {
          ...data,
          revision,
          settings: { ...settings, configured: true },
        });
      this.token = token;
      this.remember(token, settings.email);
      this.revision = revision;
      this.value.configured = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        this.value.error =
          "无法读取或解密 Confluence 配置，原文件已保留。请重新填写 token 或断开连接。";
    }
  }
  info(): ConfluenceConnection {
    return { ...this.value };
  }
  async candidate(raw: ConfluenceSettingsInput): Promise<ConnectionSnapshot> {
    const input = normalizeSettings(raw);
    const sameAccount =
      input.url === this.value.url &&
      input.deployment === this.value.deployment &&
      input.email === this.value.email &&
      input.tokenType === this.value.tokenType &&
      input.cloudId === this.value.cloudId;
    const token = input.token || (sameAccount ? this.token : "");
    if (!token) throw new Error("请填写 token；更换站点或账户后需要重新填写");
    this.remember(token, input.email);
    const { token: _secret, ...settings } = input;
    return {
      settings: { ...settings, configured: true },
      token,
      revision: this.revision,
      signal: this.controller.signal,
    };
  }
  snapshot(): ConnectionSnapshot {
    if (!this.token) throw new Error("请先在设置 → 连接中连接 Confluence");
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
      throw new Error("Confluence 连接已变更，请重新读取目标");
  }
  save(input: ConfluenceSettingsInput) {
    return this.queue.run("connection", async () => {
      const next = await this.candidate(input);
      if (!this.encryption.isEncryptionAvailable())
        throw new Error("操作系统安全存储不可用，无法保存凭据");
      const revision = randomUUID();
      await atomicJson(this.path, {
        version: 1,
        revision,
        settings: next.settings,
        encrypted: this.encryption.encryptString(next.token).toString("base64"),
      });
      this.controller.abort(new Error("Confluence 连接已变更"));
      this.controller = new AbortController();
      this.revision = revision;
      this.token = next.token;
      this.value = next.settings;
      return this.info();
    });
  }
  remove() {
    return this.queue.run("connection", async () => {
      await unlink(this.path).catch((e) => {
        if (e.code !== "ENOENT") throw e;
      });
      this.controller.abort(new Error("Confluence 连接已断开"));
      this.controller = new AbortController();
      this.revision = randomUUID();
      this.token = "";
      this.value = { ...empty };
    });
  }
}
