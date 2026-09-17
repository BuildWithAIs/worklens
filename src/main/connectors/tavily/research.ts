import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { atomicJson, SerialQueue } from "../../storage";
import type { LocalArtifacts } from "../../local-artifacts";
import type { TavilyConnections } from "./connection";
import { TavilyHttp, ServiceError, type Json } from "./http";
import { saveResult } from "./results";

interface ResearchRecord {
  revision: string;
  requestId?: string;
  state: "submitting" | "pending" | "failed" | "completed";
  result?: Json;
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** A durable handle survives compaction/restart without resubmitting a paid job. */
export class TavilyResearch {
  private queue = new SerialQueue();
  constructor(
    private connections: TavilyConnections,
    private artifacts: LocalArtifacts,
  ) {}

  private path(sessionId: string, handle: string) {
    if (!/^[a-f0-9]{64}$/.test(handle))
      throw new ServiceError("invalid_handle", "无效的研究任务标识");
    return join(
      this.artifacts.root,
      "tavily",
      "research",
      hash(sessionId),
      `${handle}.json`,
    );
  }
  private async load(path: string): Promise<ResearchRecord | undefined> {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
  private check(record: ResearchRecord, http: TavilyHttp) {
    if (record.revision !== http.connection.revision)
      throw new ServiceError(
        "invalid_handle",
        "Tavily 连接已更换，旧任务标识不可用；请在原 Tavily 账号查看结果",
      );
  }
  private pending(handle: string, record: ResearchRecord): Json {
    return (
      record.result ?? {
        handle,
        status: record.requestId ? "accepted" : "submission_unknown",
        researchStatus: record.requestId ? "pending" : "unknown",
        next: record.requestId
          ? "Call web_research_status with this handle. Do not submit again. Stopping local polling does not cancel the remote task."
          : "Submission may have reached Tavily. Do not resubmit automatically; check the Tavily account before creating another paid task.",
      }
    );
  }
  submit(sessionId: string, callKey: string, input: Json, http: TavilyHttp) {
    const handle = hash(`${http.connection.revision}:${callKey}`);
    const path = this.path(sessionId, handle);
    return this.queue.run(path, async () => {
      const existing = await this.load(path);
      if (existing) {
        this.check(existing, http);
        return this.pending(handle, existing);
      }
      http.signal.throwIfAborted();
      const record: ResearchRecord = {
        revision: http.connection.revision,
        state: "submitting",
      };
      // Persist before dispatch: a crash or lost response must not trigger a second POST.
      await atomicJson(path, record);
      try {
        const data = await http.request("POST", "/research", {
          ...input,
          stream: false,
        });
        if (
          typeof data.request_id !== "string" ||
          !/^[\w-]{1,200}$/.test(data.request_id) ||
          this.connections.redact(data.request_id) !== data.request_id
        )
          throw new ServiceError(
            "invalid_response",
            "Tavily 未返回有效的研究任务标识",
          );
        record.requestId = data.request_id;
        record.state = "pending";
        // Preserve the receipt even if the local run was just cancelled.
        await atomicJson(path, record);
        return this.pending(handle, record);
      } catch (error) {
        if (
          error instanceof ServiceError &&
          ["authentication", "quota", "invalid_request", "rate_limit"].includes(
            error.code,
          )
        ) {
          record.state = "failed";
          record.result = {
            handle,
            status: error.code,
            message: this.connections.redact(error.message),
          };
          await atomicJson(path, record);
          return record.result;
        }
        // A receipt can still be used in this run if persisting it failed.
        if (record.requestId) {
          return {
            handle,
            status: "storage_error",
            requestId: record.requestId,
            message:
              "Task created, but its receipt could not be saved. Do not submit again. Preserve this requestId for account-side recovery.",
          };
        }
        return this.pending(handle, record);
      }
    });
  }
  status(
    sessionId: string,
    handle: string,
    waitSeconds: number,
    http: TavilyHttp,
  ) {
    const path = this.path(sessionId, handle);
    return this.queue.run(path, async () => {
      const record = await this.load(path);
      if (!record)
        throw new ServiceError("invalid_handle", "未找到当前会话的研究任务");
      this.check(record, http);
      if (record.result || !record.requestId)
        return this.pending(handle, record);
      const deadline = Date.now() + waitSeconds * 1000;
      for (;;) {
        http.signal.throwIfAborted();
        const data = await http.request(
          "GET",
          `/research/${encodeURIComponent(record.requestId)}`,
        );
        if (data.request_id !== record.requestId)
          throw new ServiceError(
            "invalid_response",
            "Tavily 返回了不匹配的研究任务",
          );
        if (data.status === "completed") {
          if (
            typeof data.content !== "string" &&
            (!data.content || typeof data.content !== "object")
          )
            throw new ServiceError(
              "invalid_response",
              "Tavily 研究报告缺少正文",
            );
          try {
            const sourceData = await saveResult(
              this.connections,
              this.artifacts,
              sessionId,
              "tavily-research.json",
              JSON.stringify(data, null, 2),
              http.signal,
            );
            const report =
              typeof data.content === "string"
                ? data.content
                : JSON.stringify(data.content, null, 2);
            const sources = Array.isArray(data.sources)
              ? data.sources
                  .map(
                    (source: Json) =>
                      `- ${String(source.title ?? "Source")}: ${String(source.url ?? "")}`,
                  )
                  .join("\n")
              : "";
            const saved = await saveResult(
              this.connections,
              this.artifacts,
              sessionId,
              "tavily-research.md",
              `${report}\n\n## Sources\n\n${sources}\n`,
              http.signal,
            );
            record.state = "completed";
            record.result = {
              ...saved,
              handle,
              status: "success",
              researchStatus: "completed",
              sourceDataPath: sourceData.rawResultPath,
            };
            await atomicJson(path, record);
            return record.result;
          } catch (error) {
            if (http.signal.aborted) throw error;
            return {
              handle,
              status: "storage_error",
              researchStatus: "completed",
              next: "Report could not be saved. Retry web_research_status with the same handle; do not create another task.",
            };
          }
        }
        if (data.status === "failed") {
          record.state = "failed";
          record.result = {
            handle,
            status: "research_failed",
            researchStatus: "failed",
            message: this.connections.redact(
              String(data.error ?? "Tavily research failed").slice(0, 800),
            ),
          };
          await atomicJson(path, record);
          return record.result;
        }
        if (!["pending", "in_progress"].includes(data.status))
          throw new ServiceError(
            "invalid_response",
            "Tavily 返回了未知的研究状态",
          );
        if (Date.now() >= deadline)
          return {
            ...this.pending(handle, record),
            researchStatus: data.status,
          };
        await delay(Math.min(5000, deadline - Date.now()), undefined, {
          signal: http.signal,
        });
      }
    });
  }
}
