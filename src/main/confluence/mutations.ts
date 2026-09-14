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
          ![
            "upload_attachment",
            "set_property",
            "delete_property",
            "edit_page",
            "append_page",
            "replace_page",
            "rename_page",
            "restore_version",
          ].includes(a.operation)
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
        try {
          await atomicJson(path, {
            status: "unknown",
            message: "写入已开始；如未收到结果，请读取目标核实，不要重复提交。",
          });
        } catch {
          throw new ServiceError(
            "storage_error",
            "无法保存写入日志，尚未发送修改请求。请检查本地存储后重试。",
          );
        }
        sent = true;
        return execute();
      };
      let result: Json;
      try {
        result = await write(ctx, a, dispatch);
      } catch (e) {
        if (sent) {
          const result = {
            status: e instanceof ServiceError ? e.code : "unknown",
            message:
              e instanceof Error
                ? ctx.operations.connections.redact(e.message)
                : "写入结果不确定",
          };
          // Keep the pending journal if recording the failure also fails.
          // A local storage error must not hide the remote operation's outcome.
          await atomicJson(path, result).catch(() => {});
          throw e instanceof ServiceError
            ? e
            : new ServiceError(result.status, result.message);
        }
        throw e;
      }
      try {
        await atomicJson(
          path,
          JSON.parse(ctx.operations.connections.redact(JSON.stringify(result))),
        );
        return result;
      } catch {
        // The remote result is known. Preserve it even if the journal cannot
        // be finalized; the pending record still prevents identical retries.
        return {
          ...result,
          journalWarning:
            "远端操作结果已收到，但本地完成日志保存失败。请保留本次结果；不要重复提交，后续操作前先读取目标核实。",
        };
      }
    });
  }
}
