import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { atomicJson, SerialQueue, type Encryption } from "../storage";
import { PermissionError, type ReadRule } from "./types";
import { freezeJson } from "./operation-plan";
const text = z.string().min(1).max(4096);
const ruleSchema = z
  .object({
    id: z.uuid(),
    conversationId: text,
    path: text,
    identity: text,
    subtree: z.boolean(),
    actions: z
      .array(z.enum(["file.read", "file.list"]))
      .min(1)
      .max(2),
    enabled: z.boolean(),
  })
  .strict();
const stateSchema = z
  .object({
    version: z.literal(1),
    revision: z.uuid(),
    rules: z.array(ruleSchema).max(512),
  })
  .strict()
  .refine((v) => new Set(v.rules.map((r) => r.id)).size === v.rules.length);
export type SavedPermissions = z.infer<typeof stateSchema>;
/** Own protected application data only. This is not a user-file FileBoundary. */
export class PermissionDocument<T> {
  constructor(
    private path: string,
    private encryption: Encryption,
    private parse: (v: unknown) => T,
    private maxBytes = 8 * 1024 * 1024,
  ) {}
  async read(): Promise<T | undefined> {
    let handle;
    try {
      if (!this.encryption.isEncryptionAvailable())
        throw new Error("Encryption unavailable");
      handle = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > this.maxBytes)
        throw new Error("Invalid permission document");
      const outer = z
        .object({
          version: z.literal(1),
          encrypted: z
            .string()
            .max(this.maxBytes)
            .regex(/^[A-Za-z0-9+/]*={0,2}$/),
        })
        .strict()
        .parse(JSON.parse(await this.readBounded(handle)));
      if (!this.encryption.isEncryptionAvailable())
        throw new Error("Encryption unavailable");
      return this.parse(
        JSON.parse(
          this.encryption.decryptString(Buffer.from(outer.encrypted, "base64")),
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    } finally {
      await handle?.close();
    }
  }
  private async readBounded(handle: Awaited<ReturnType<typeof open>>) {
    const buffer = Buffer.alloc(this.maxBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        size,
        buffer.length - size,
        null,
      );
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > this.maxBytes)
      throw new Error("Permission document exceeds limit");
    return buffer.subarray(0, size).toString("utf8");
  }
  async write(value: T) {
    if (!this.encryption.isEncryptionAvailable())
      throw new Error("Encryption unavailable");
    const data = JSON.stringify(this.parse(value));
    if (Buffer.byteLength(data) > this.maxBytes / 2)
      throw new Error("Permission document exceeds limit");
    const encrypted = this.encryption.encryptString(data).toString("base64");
    if (encrypted.length > this.maxBytes - 100)
      throw new Error("Permission document exceeds limit");
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await atomicJson(this.path, { version: 1, encrypted });
    // Flush the renamed directory entry as well as atomicJson's file contents.
    // Windows durability requires its platform adapter before that release gate.
    if (process.platform !== "win32") {
      const parent = await open(
        dirname(this.path),
        constants.O_RDONLY | constants.O_DIRECTORY,
      );
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    }
  }
}
export class PermissionStore {
  private document: PermissionDocument<SavedPermissions>;
  private queue = new SerialQueue();
  private saved: SavedPermissions = {
    version: 1,
    revision: randomUUID(),
    rules: [],
  };
  private ready = false;
  constructor(path: string, encryption: Encryption) {
    this.document = new PermissionDocument(path, encryption, (v) =>
      stateSchema.parse(v),
    );
  }
  async load() {
    try {
      this.saved = freezeJson((await this.document.read()) ?? this.saved);
      this.ready = true;
    } catch {
      this.ready = false;
    }
  }
  get available() {
    return this.ready;
  }
  get value(): Readonly<SavedPermissions> {
    return this.saved;
  }
  update(expectedRevision: string, rules: ReadRule[]) {
    return this.queue.run("rules", async () => {
      if (!this.ready)
        throw new PermissionError("PERMISSION_STORE_UNAVAILABLE");
      if (this.saved.revision !== expectedRevision)
        throw new PermissionError("PERMISSION_STALE");
      const next = stateSchema.parse({
        version: 1,
        revision: randomUUID(),
        rules,
      });
      try {
        await this.document.write(next);
      } catch {
        this.ready = false;
        throw new PermissionError("PERMISSION_STORE_UNAVAILABLE");
      }
      this.saved = freezeJson(next);
    });
  }
}
