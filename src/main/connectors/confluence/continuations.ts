import { createHash, randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { atomicJson } from "../../storage";
import { ServiceError } from "./http";

const recordSchema = z
  .object({
    path: z.string().max(16000),
    scope: z.string().max(16000),
    sessionId: z.string(),
    revision: z.string(),
    expiresAt: z.number(),
  })
  .strict();
type Scope = Pick<
  z.infer<typeof recordSchema>,
  "scope" | "sessionId" | "revision"
>;
const TTL = 7 * 24 * 60 * 60 * 1000;

/** Disk-backed cursors survive restart; expiry and saved connection revision bound reuse. */
export class Continuations {
  constructor(private root: string) {}
  private path(sessionId: string, id: string) {
    const session = createHash("sha256").update(sessionId).digest("hex");
    return join(this.root, "continuations", session, id + ".json");
  }
  async save(scope: Scope, path: string) {
    const id = randomUUID();
    await atomicJson(this.path(scope.sessionId, id), {
      ...scope,
      path,
      expiresAt: Date.now() + TTL,
    });
    return id;
  }
  async resolve(scope: Scope, id: string) {
    const fail = () =>
      new ServiceError(
        "invalid_continuation",
        "分页标识已过期或不属于当前连接、会话及查询。移除 continuation 并重发原查询，从头获取并按资源 ID 去重；不要推测游标。",
      );
    if (!z.uuid().safeParse(id).success) throw fail();
    const path = this.path(scope.sessionId, id);
    try {
      const saved = recordSchema.parse(
        JSON.parse(await readFile(path, "utf8")),
      );
      if (saved.expiresAt < Date.now()) {
        await unlink(path).catch(() => {});
        throw fail();
      }
      if (
        saved.scope !== scope.scope ||
        saved.revision !== scope.revision ||
        saved.sessionId !== scope.sessionId
      )
        throw fail();
      return saved.path;
    } catch {
      throw fail();
    }
  }
}
