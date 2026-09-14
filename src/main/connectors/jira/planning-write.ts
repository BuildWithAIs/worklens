import type { Execution } from "./context";
import { ServiceError, type Json } from "./http";
import { segment } from "./adapter";
import type { Dispatch } from "./write";

export async function completeSprint(
  ctx: Execution,
  a: Json,
  send: Dispatch,
): Promise<Json> {
  const d = ctx.adapter;
  const path = d.agile + "/sprint/" + segment(a.sprint);
  const current = await d.get(path);
  if (current.state !== "active")
    throw new ServiceError("conflict", "只能完成 active Sprint");
  if (a.unfinished.destination === "sprint" && a.unfinished.sprint === a.sprint)
    throw new ServiceError(
      "invalid_target",
      "未完成工单的目标不能是当前 Sprint",
    );
  const config = await d.get(
    d.agile + "/board/" + segment(a.board) + "/configuration",
  );
  if (String(current.originBoardId) !== a.board)
    throw new ServiceError(
      "invalid_target",
      "请使用 Sprint 的 originBoardId 以确定完成状态",
    );
  const done = config.columnConfig?.columns
    ?.at(-1)
    ?.statuses?.map((s: Json) => s.id);
  if (!Array.isArray(done))
    throw new ServiceError("unavailable", "无法确定看板完成列");
  const rows = await d.all(path + "/issue", "issues");
  const remaining = rows
    .filter((r) => !done.includes(r.fields?.status?.id))
    .map((r) => r.key);
  if (remaining.length > 50)
    throw new ServiceError(
      "limit",
      "未完成工单超过 50 条，请在 Jira 中完成 Sprint",
    );
  if (a.unfinished.destination === "sprint") {
    const destination = await d.get(
      d.agile + "/sprint/" + segment(a.unfinished.sprint),
    );
    if (!["future", "active"].includes(destination.state))
      throw new ServiceError(
        "invalid_target",
        "目标 Sprint 必须为 future 或 active",
      );
  }
  // Close while unfinished issues still belong to this sprint, preserving history.
  // Both Cloud and DC support partial close followed by an explicit move.
  const closed = await send("sprint:close", "POST", path, { state: "closed" });
  const results: Json[] = [
    { step: "close", status: "success", result: closed },
  ];
  if (!remaining.length) return { results };
  const target =
    a.unfinished.destination === "backlog"
      ? d.agile + "/backlog/issue"
      : d.agile + "/sprint/" + segment(a.unfinished.sprint) + "/issue";
  try {
    const result = await send("sprint:move", "POST", target, {
      issues: remaining,
    });
    results.push({
      step: "move",
      status: "success",
      issues: remaining,
      result,
    });
  } catch (error) {
    return {
      status: "partial",
      results,
      failedStep: "move",
      issues: remaining,
      destination: a.unfinished,
      outcome: error instanceof ServiceError ? error.code : "unknown",
      message: String(error),
      retry:
        "Sprint is closed. Reconcile issue locations, then move only remaining issues with move_to_backlog/move_to_sprint; do not complete the sprint again.",
    };
  }
  return { results };
}
