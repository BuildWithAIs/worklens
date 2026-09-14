import type { MessageView } from "../shared/contracts";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
type RecordValue = Record<string, any>;
const bounded = (value: string) =>
  value.length > 24000
    ? value.slice(0, 24000) + "\n…输出已截断，完整结果保存在 Pi 会话中。"
    : value;
export function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}
export function projectMessages(
  messages: readonly unknown[],
  runtimeCwd?: string,
): MessageView[] {
  const result: MessageView[] = [];
  for (const [index, raw] of messages.entries()) {
    const message = raw as RecordValue;
    const id = `m-${index}`;
    const firstNew = result.length;
    if (message.role === "user")
      result.push({ id, role: "user", text: textContent(message.content) });
    if (message.role === "assistant") {
      const thinking = Array.isArray(message.content)
        ? message.content
            .filter((b: RecordValue) => b.type === "thinking")
            .map((b: RecordValue) => b.thinking)
            .join("\n")
        : "";
      const text = textContent(message.content);
      if (text || thinking || message.errorMessage)
        result.push({
          id,
          role: "assistant",
          text,
          thinking: thinking || undefined,
          error: message.errorMessage,
        });
      for (const block of Array.isArray(message.content)
        ? message.content
        : []) {
        if (block.type === "toolCall")
          result.push({
            id: block.id,
            role: "tool",
            text: "",
            toolId: block.id,
            toolName: block.name,
            args: bounded(JSON.stringify(block.arguments ?? {}, null, 2)),
            shellCwd: ["bash", "powershell"].includes(block.name)
              ? runtimeCwd
              : undefined,
            timeoutSeconds:
              typeof block.arguments?.timeout === "number"
                ? block.arguments.timeout
                : undefined,
            targetPath:
              runtimeCwd && typeof block.arguments?.path === "string"
                ? block.arguments.path === "~"
                  ? homedir()
                  : /^~[\\/]/.test(block.arguments.path)
                    ? join(homedir(), block.arguments.path.slice(2))
                    : resolve(runtimeCwd, block.arguments.path)
                : undefined,
            status: message.stopReason === "aborted" ? "cancelled" : "pending",
          });
      }
    }
    if (message.role === "toolResult") {
      let tool = result.find((item) => item.toolId === message.toolCallId);
      if (!tool) {
        tool = {
          id: message.toolCallId ?? id,
          toolId: message.toolCallId,
          toolName: message.toolName,
          role: "tool",
          text: "",
        };
        result.push(tool);
      }
      tool.text = bounded(
        textContent(message.content) +
          (message.details?.diff ? "\n" + message.details.diff : ""),
      );
      if (Array.isArray(message.details?.artifacts)) tool.artifacts = message.details.artifacts;
      tool.status = message.isError
        ? /\babort(?:ed)?\b|\bcancell?ed\b|已取消/i.test(tool.text)
          ? "cancelled"
          : /Command timed out after \d+(?:\.\d+)? seconds\s*$/.test(tool.text)
            ? "timeout"
            : "error"
        : "success";
      if (["bash", "powershell"].includes(tool.toolName ?? "")) {
        const exitCode = message.details?.worklensShell?.exitCode;
        const failureCode = /Command exited with code (-?\d+)\s*$/.exec(
          textContent(message.content),
        );
        tool.exitCode =
          typeof exitCode === "number" || exitCode === null
            ? exitCode
            : failureCode
              ? Number(failureCode[1])
              : undefined;
      }
    }
    if (message.role === "compactionSummary")
      result.push({
        id,
        role: "summary",
        text: bounded(message.summary ?? textContent(message.content)),
      });
    for (const item of result.slice(firstNew)) {
      if (typeof message.timestamp === "number" && Number.isFinite(message.timestamp) && !Number.isNaN(new Date(message.timestamp).getTime())) item.createdAt = new Date(message.timestamp).toISOString();
      if (typeof message.runStartedAt === "string") item.runStartedAt = message.runStartedAt;
      if (typeof message.runElapsedMs === "number") item.runElapsedMs = message.runElapsedMs;
    }
  }
  return result;
}

// Run markers are persisted alongside messages, so timing survives navigation and restart.
export function withRunTiming(branch: readonly unknown[]): unknown[] {
  const runs = new Map<string, { runStartedAt: string; runElapsedMs?: number }>();
  for (const raw of branch) {
    const entry = raw as RecordValue;
    const data = entry.data;
    if (entry.type !== "custom" || typeof data?.runId !== "string") continue;
    if (entry.customType === "worklens.run-start" && Number.isFinite(Date.parse(data.startedAt))) {
      runs.set(data.runId, { runStartedAt: data.startedAt });
    }
    if (entry.customType === "worklens.run-end") {
      const run = runs.get(data.runId);
      const end = Date.parse(data.endedAt);
      if (run && Number.isFinite(end) && end >= Date.parse(run.runStartedAt)) {
        run.runElapsedMs = end - Date.parse(run.runStartedAt);
      }
    }
  }
  let timing: { runStartedAt: string; runElapsedMs?: number } | undefined;
  return branch.flatMap((raw) => {
    const entry = raw as RecordValue;
    if (entry.type === "custom" && entry.customType === "worklens.run-start") timing = runs.get(entry.data?.runId);
    if (entry.type === "custom" && entry.customType === "worklens.run-end") timing = undefined;
    if (entry.type === "message") return [{ ...entry.message, ...timing }];
    if (entry.type === "compaction") return [{ role: "compactionSummary", summary: entry.summary }];
    return [];
  });
}
