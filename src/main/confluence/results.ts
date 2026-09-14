import type { Execution } from "./operation-context";
import type { Json } from "./http";
import type { LocalArtifact } from "../../shared/contracts";

const RESOURCE_STATUSES = new Set([
  "current",
  "draft",
  "trashed",
  "archived",
  "historical",
  "open",
  "resolved",
  "complete",
  "incomplete",
]);
const RETRIEVAL_THRESHOLD = 1800;
const INLINE_BUDGET = 10000;

/** Recovery fields precede content because Pi compaction keeps 2,000 chars per result. */
export async function result(ctx: Execution, input: Json) {
  const { rawItems, ...value } = input;
  const resourceStatus = RESOURCE_STATUSES.has(value.status)
    ? value.status
    : undefined;
  const status = resourceStatus ? "success" : (value.status ?? "success");
  const artifacts: LocalArtifact[] = [...(value.artifacts ?? [])];
  const recovery = {
    status,
    journalWarning: value.journalWarning,
    id: value.id ?? value.pageId ?? value.attachmentId,
    version: value.version,
    complete: value.complete,
    continuation: value.continuation,
    nextOffset: value.nextOffset,
    offset: value.offset,
    resourceStatus,
  };
  const full = ctx.operations.connections.redact(
    JSON.stringify(
      {
        ...recovery,
        source: ctx.connection.settings.url,
        ...value,
        ...(rawItems ? { items: rawItems, itemsSummarized: false } : {}),
        status,
      },
      null,
      2,
    ),
  );
  let resultPath: string | undefined;
  let retrievalError: string | undefined;
  if (rawItems || full.length > RETRIEVAL_THRESHOLD) {
    try {
      const saved = await ctx.operations.artifacts.save(
        ctx.sessionId,
        "confluence-result.json",
        full,
        {},
        ctx.signal,
      );
      artifacts.push(saved);
      resultPath = saved.path;
    } catch (error) {
      // Output persistence must not turn a completed remote mutation into a failed mutation.
      retrievalError = ctx.operations.connections.redact(
        error instanceof Error ? error.message : "Result file unavailable",
      );
    }
  }
  const envelope = {
    ...recovery,
    resultPath,
    retrievalError,
    source: ctx.connection.settings.url,
    retrieval: resultPath
      ? "Use read on resultPath for the complete result after compaction; do not repeat a mutation."
      : undefined,
    ...(JSON.stringify(value).length > INLINE_BUDGET
      ? {
          truncated: true,
          preview: JSON.stringify(value).slice(0, 4000),
        }
      : value),
    status,
  };
  const text = ctx.operations.connections.redact(JSON.stringify(envelope));
  return {
    isError: !["success", "accepted"].includes(status),
    content: [{ type: "text" as const, text }],
    details: { artifacts, status },
  };
}
