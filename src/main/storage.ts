import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type {
  Credential,
  CredentialStore,
  AuthOperationOptions,
  CredentialInfo,
  ModelsStore,
  ModelsStoreEntry,
  ModelsStoreOperationOptions,
} from "@earendil-works/pi-ai";
import type { Settings } from "../shared/contracts";

export async function atomicJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temporary, path);
}
export class SerialQueue {
  private pending = new Map<string, Promise<unknown>>();
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const task = (this.pending.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(fn);
    this.pending.set(key, task);
    void task
      .finally(() => {
        if (this.pending.get(key) === task) this.pending.delete(key);
      })
      .catch(() => {});
    return task;
  }
}
export interface Encryption {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
// Preserve DTO keys and numeric state; redaction must never rewrite JSON syntax.
export function redactStrings<T>(
  value: T,
  redact: (text: string) => string,
): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value))
    return value.map((item) => redactStrings(item, redact)) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactStrings(item, redact),
      ]),
    ) as T;
  return value;
}
export class SecureCredentials implements CredentialStore {
  private queue = new SerialQueue();
  private knownSecrets = new Set<string>();
  private failures = new Map<string, string>();
  diagnosticFor(id: string): string | undefined {
    return this.failures.get(id);
  }
  constructor(
    private directory: string,
    private encryption: Encryption,
  ) {}
  private path(id: string) {
    return join(
      this.directory,
      `${createHash("sha256").update(id).digest("hex")}.json`,
    );
  }
  private remember(credential: Credential) {
    const visit = (value: unknown): void => {
      if (typeof value === "string" && value.length >= 6)
        this.knownSecrets.add(value);
      else if (value && typeof value === "object")
        Object.values(value).forEach(visit);
    };
    const { type: _type, ...data } = credential;
    visit(data);
    for (const key of ["key", "access", "refresh"] as const) {
      const value = (credential as unknown as Record<string, unknown>)[key];
      if (typeof value === "string" && value.length > 0)
        this.knownSecrets.add(value);
    }
  }
  redact(value: string) {
    const forms = [...this.knownSecrets].flatMap((secret) => [
      secret,
      JSON.stringify(secret).slice(1, -1),
    ]);
    for (const secret of forms.sort((a, b) => b.length - a.length))
      value = value.split(secret).join("[已隐藏]");
    return value
      .replace(/(Bearer\s+)[^\s"']+/gi, "$1[已隐藏]")
      .replace(/\bsk-[\w-]+/g, "[已隐藏]")
      .replace(/([?&](?:key|token|code|secret)=)[^&\s]+/gi, "$1[已隐藏]");
  }
  async read(
    id: string,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    try {
      const data = JSON.parse(await readFile(this.path(id), "utf8"));
      if (data.version !== 1 || data.provider !== id)
        throw new Error("凭据格式无法识别");
      const credential = JSON.parse(
        this.encryption.decryptString(Buffer.from(data.encrypted, "base64")),
      ) as Credential;
      if (!credential || !["api_key", "oauth"].includes(credential.type))
        throw new Error("凭据内容无法识别");
      this.remember(credential);
      this.failures.delete(id);
      return credential;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.failures.delete(id);
        return undefined;
      }
      // Pi permits best-effort stores. Keep the original file untouched while
      // allowing settings to display the failure and explicitly replace it.
      this.failures.set(
        id,
        "无法读取或解密已保存的凭据，请重新配置或移除凭据。原文件尚未修改。",
      );
      return undefined;
    }
  }
  async list(options?: AuthOperationOptions): Promise<CredentialInfo[]> {
    const { readdir } = await import("node:fs/promises");
    await mkdir(this.directory, { recursive: true });
    const result: CredentialInfo[] = [];
    for (const file of await readdir(this.directory)) {
      options?.signal?.throwIfAborted();
      if (!file.endsWith(".json")) continue;
      try {
        const data = JSON.parse(
          await readFile(join(this.directory, file), "utf8"),
        );
        if (
          typeof data.provider !== "string" ||
          this.path(data.provider) !== join(this.directory, file)
        )
          continue;
        const credential = await this.read(data.provider, options);
        if (credential)
          result.push({ providerId: data.provider, type: credential.type });
      } catch {
        options?.signal?.throwIfAborted();
      }
    }
    return result;
  }
  modify(
    id: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ) {
    return this.queue.run(id, async () => {
      options?.signal?.throwIfAborted();
      const current = await this.read(id, options);
      const next = await fn(current);
      if (next) {
        options?.signal?.throwIfAborted();
        if (!this.encryption.isEncryptionAvailable())
          throw new Error("操作系统安全存储不可用，无法保存凭据");
        this.remember(next);
        await atomicJson(this.path(id), {
          version: 1,
          provider: id,
          encrypted: this.encryption
            .encryptString(JSON.stringify(next))
            .toString("base64"),
        });
        this.failures.delete(id);
      }
      return next ?? current;
    });
  }
  delete(id: string, options?: AuthOperationOptions) {
    return this.queue.run(id, async () => {
      options?.signal?.throwIfAborted();
      const { unlink } = await import("node:fs/promises");
      await unlink(this.path(id)).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      this.failures.delete(id);
    });
  }
}
export class StateStore {
  value: Settings = { version: 1, theme: "system", riskAccepted: false };
  private queue = new SerialQueue();
  constructor(private path: string) {}
  async load() {
    try {
      const stored = JSON.parse(await readFile(this.path, "utf8"));
      if (stored.version !== 1) throw new Error("应用设置版本不受支持");
      this.value = { ...this.value, ...stored };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  update(patch: Partial<Settings>) {
    return this.queue.run("state", async () => {
      const next = { ...this.value, ...patch, version: 1 as const };
      await atomicJson(this.path, next);
      this.value = next;
      return next;
    });
  }
}
export class ModelCache implements ModelsStore {
  private queue = new SerialQueue();
  constructor(private directory: string) {}
  private path(id: string) {
    return join(
      this.directory,
      `${createHash("sha256").update(id).digest("hex")}.json`,
    );
  }
  async read(
    id: string,
    options?: ModelsStoreOperationOptions,
  ): Promise<ModelsStoreEntry | undefined> {
    options?.signal?.throwIfAborted();
    try {
      const value = JSON.parse(await readFile(this.path(id), "utf8"));
      return value.version === 1 ? value.entry : undefined;
    } catch {
      return undefined;
    }
  }
  write(
    id: string,
    entry: ModelsStoreEntry,
    options?: ModelsStoreOperationOptions,
  ) {
    return this.queue.run(id, async () => {
      options?.signal?.throwIfAborted();
      await atomicJson(this.path(id), { version: 1, entry });
    });
  }
  delete(id: string, options?: ModelsStoreOperationOptions) {
    return this.queue.run(id, async () => {
      options?.signal?.throwIfAborted();
      const { unlink } = await import("node:fs/promises");
      await unlink(this.path(id)).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    });
  }
}
