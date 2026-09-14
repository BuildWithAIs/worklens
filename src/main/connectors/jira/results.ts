import type { Execution } from "./context";
import type { Json } from "./http";
export async function toolResult(ctx: Execution, value: Json) {
  const status = value.status ?? "success";
  const full = ctx.connections.redact(
    JSON.stringify(
      { ...value, status, source: ctx.connection.settings.url },
      null,
      2,
    ),
  );
  let resultPath: string | undefined;
  let retrievalError: string | undefined;
  if (full.length > 1800) {
    try {
      resultPath = (
        await ctx.artifacts.save(
          ctx.sessionId,
          "jira-result.json",
          full,
          {},
          undefined,
          "jira",
        )
      ).path;
    } catch (error) {
      retrievalError = ctx.connections.redact(String(error));
    }
  }
  const envelope = {
    status,
    operationId: value.operationId,
    resultPath,
    retrievalError,
    ...(retrievalError
      ? {
          retrieval:
            "Full result is included inline because saving failed. Preserve it before compaction; do not repeat successful writes.",
        }
      : {}),
    complete: value.complete,
    continuation: value.continuation,
    journalWarning: value.journalWarning,
    source: ctx.connection.settings.url,
    ...(full.length > 10000 && resultPath
      ? {
          truncated: true,
          preview: full.slice(0, 4000),
          retrieval: "Read resultPath for full data; do not repeat writes.",
        }
      : value),
  };
  return {
    isError: !["success", "accepted"].includes(status),
    content: [
      {
        type: "text" as const,
        text: ctx.connections.redact(JSON.stringify(envelope)),
      },
    ],
    details: { status, artifacts: value.artifacts ?? [] },
  };
}
