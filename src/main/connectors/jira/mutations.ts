import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicJson } from "../../storage";
import type { Execution } from "./context";
import { ReadLimiter, ServiceError, type Json } from "./http";
import type { WriteRequest } from "./schema";
import { write } from "./write";
/** Serial writes across sessions; local journals prevent blind duplicate dispatch, not remote transactions. */
export class MutationRunner {
  private limiter = new ReadLimiter(1);
  run(ctx: Execution, request: WriteRequest, runId: string) {
    return this.limiter.run(ctx.signal, async () => {
      const id = createHash("sha256")
        .update(
          JSON.stringify([
            "jira",
            ctx.sessionId,
            runId,
            ctx.connection.revision,
            request,
          ]),
        )
        .digest("hex");
      const path = join(ctx.artifacts.root, "jira", "operations", id + ".json");
      const existing = await readFile(path, "utf8").catch((e) => {
        if (e.code !== "ENOENT")
          throw new ServiceError(
            "storage_error",
            "无法读取写入日志，尚未发送修改请求",
          );
      });
      if (existing) return { ...JSON.parse(existing), replayed: true };
      const steps: Json[] = [];
      let started = false;
      let journalWarning: string | undefined;
      const persist = (data: Json) =>
        atomicJson(
          path,
          JSON.parse(
            ctx.connections.redact(
              JSON.stringify({
                ...data,
                operationId: id,
                sessionId: ctx.sessionId,
                revision: ctx.connection.revision,
              }),
            ),
          ),
        );
      let result: Json;
      try {
        result = await write(
          ctx,
          request,
          async (step, method, target, body) => {
            ctx.connections.assertCurrent(ctx.connection);
            ctx.signal.throwIfAborted();
            try {
              await persist({
                status: "unknown",
                message: "写入已开始；请核实目标，不要重复提交",
                pendingStep: step,
                steps,
              });
            } catch {
              throw new ServiceError(
                "storage_error",
                "无法记录写入日志，当前步骤尚未发送",
              );
            }
            started = true;
            try {
              const data = await ctx.adapter.http.json(target, method, body);
              steps.push({ step, status: "success", data });
              try {
                await persist({
                  status: "unknown",
                  message: "组合操作尚未结束；请检查已完成步骤",
                  steps,
                });
              } catch {
                journalWarning =
                  "远端步骤已成功，但本地完成日志保存失败；保留结果，不要重复提交";
              }
              return data;
            } catch (error) {
              const status =
                error instanceof ServiceError ? error.code : "unknown";
              steps.push({ step, status });
              throw error;
            }
          },
        );
        if (Array.isArray(result)) result = { items: result };
        // Remote resource status (e.g. Jira status object) never becomes execution status.
        if (typeof result.status !== "string")
          result = { ...result, status: "success" };
      } catch (error) {
        const status =
          error instanceof ServiceError
            ? error.code
            : ctx.signal.aborted
              ? "cancelled"
              : "invalid_request";
        if (!started) throw error;
        result = {
          status: steps.some((s) => s.status === "success")
            ? "partial"
            : status,
          outcome: status,
          message: error instanceof Error ? error.message : String(error),
          steps,
        };
      }
      if (started)
        try {
          await persist(result);
        } catch {
          journalWarning =
            "远端结果已收到，但本地完成日志保存失败；不要重复提交";
        }
      return {
        ...result,
        operationId: started ? id : undefined,
        ...(journalWarning ? { journalWarning } : {}),
      };
    });
  }
}
