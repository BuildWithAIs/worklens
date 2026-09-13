import type { WriteRequest } from "./schema";
import type { Execution } from "./operation-context";
import { ServiceError, type Json } from "./http";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicJson } from "../storage";
import { ReadLimiter } from "./http";
import { write } from "./write";
export class MutationRunner {
  private mutations = new ReadLimiter(1);
  async run(ctx: Execution, a: WriteRequest, runId: string) {
    // Serialize integration writes across conversations. Server versions still protect other clients.
    return this.mutations.run(ctx.signal, async () => {
      ctx.signal.throwIfAborted();
      ctx.operations.connections.assertCurrent(ctx.connection);
      if (ctx.connection.settings.access === "read")
        throw new ServiceError("permission", "此连接仅允许读取");
      const digest = createHash("sha256")
        .update(
          JSON.stringify([ctx.sessionId, runId, ctx.connection.revision, a]),
        )
        .digest("hex");
      const path = join(
        ctx.operations.artifacts.root,
        "operations",
        digest + ".json",
      );
      const previous = await readFile(path, "utf8").catch((e) => {
        if (e.code !== "ENOENT") throw e;
        return undefined;
      });
      if (previous) return { ...JSON.parse(previous), replayed: true };
      let sent = false;
      const dispatch = async (execute: () => Promise<Json>) => {
        ctx.operations.connections.assertCurrent(ctx.connection);
        ctx.signal.throwIfAborted();
        if (
          "page" in a &&
          "expectedVersion" in a &&
          a.expectedVersion &&
          !["upload_attachment", "set_property", "delete_property"].includes(
            a.operation,
          )
        ) {
          const latest = await ctx.adapter.page(
            a.page,
            a.kind,
            undefined,
            ["restore_page", "delete_page_permanently"].includes(a.operation)
              ? "trashed"
              : "current",
          );
          ctx.adapter.assertVersion(latest.version, a.expectedVersion);
        }
        await atomicJson(path, {
          status: "unknown",
          message: "写入已开始；如未收到结果，请读取目标核实，不要重复提交。",
        });
        sent = true;
        return execute();
      };
      try {
        const result = await write(ctx, a, dispatch);
        await atomicJson(
          path,
          JSON.parse(ctx.operations.connections.redact(JSON.stringify(result))),
        );
        return result;
      } catch (e) {
        if (sent) {
          const result = {
            status: e instanceof ServiceError ? e.code : "unknown",
            message:
              e instanceof Error
                ? ctx.operations.connections.redact(e.message)
                : "写入结果不确定",
          };
          await atomicJson(path, result);
        }
        throw e;
      }
    });
  }
}
