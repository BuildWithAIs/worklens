import type { LocalArtifacts } from "../../local-artifacts";
import type { GitHubConnections } from "./connection";
import type { Json } from "./http";

import { readableLines } from "../../readable-lines";

/** Successes and errors share the same recoverable output budget. */
export async function toolResult(
  connections: GitHubConnections,
  artifacts: LocalArtifacts,
  sessionId: string,
  value: Json,
  source?: string,
) {
  const status = value.status ?? "success";
  const full = connections.redact(
    JSON.stringify({ ...value, status, source }, null, 2),
  );
  let resultPath: string | undefined;
  let rawResultPath: string | undefined;
  let retrievalError: string | undefined;
  let lines: string[] = [];
  if (full.length > 1800) {
    try {
      const raw = await artifacts.save(
        sessionId,
        "github-result.json",
        full,
        {},
        undefined,
        "github",
      );
      rawResultPath = raw.path;
      lines = readableLines(full);
      const readable = lines.join("\n");
      resultPath =
        readable === full
          ? raw.path
          : (
              await artifacts.save(
                sessionId,
                "github-result.txt",
                readable,
                {},
                undefined,
                "github",
              )
            ).path;
    } catch {
      // Match Jira/Confluence: preserve data and remote status when recovery storage fails.
      retrievalError =
        "无法保存可续读的结果文件；完整结果保留在本次输出中。不要重复已成功的写入。";
    }
  }
  const preview: string[] = [];
  let length = 0;
  for (const line of lines) {
    if (preview.length === 200 || length + line.length + 1 > 4000) break;
    preview.push(line);
    length += line.length + 1;
  }
  const envelope = {
    status,
    operationId: value.operationId,
    resultPath,
    rawResultPath,
    retrievalError,
    source,
    complete: value.complete,
    continuation: value.continuation,
    journalWarning: value.journalWarning,
    retrieval: resultPath
      ? "Use read with path=resultPath, offset=1, limit=200; continue at the next unread line. Long lines are display-wrapped; rawResultPath preserves exact JSON and string contents. Never repeat successful writes."
      : retrievalError
        ? "Full result is included inline because saving failed. Preserve it before compaction; do not repeat successful writes."
        : undefined,
    ...(full.length > 10000 && resultPath
      ? {
          truncated: true,
          preview: preview.join("\n"),
          previewLines: preview.length,
          nextOffset: preview.length + 1,
          totalLines: lines.length,
        }
      : value),
  };
  return {
    isError: !["success", "accepted"].includes(status),
    content: [
      {
        type: "text" as const,
        text: connections.redact(JSON.stringify(envelope)),
      },
    ],
    details: { status, artifacts: value.artifacts ?? [] },
  };
}
