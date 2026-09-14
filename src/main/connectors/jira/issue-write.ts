import type { Execution } from "./context";
import { ServiceError, type Json } from "./http";
import { query } from "./adapter";
import { encodeDocument } from "./content";
import type { Dispatch } from "./write";

export function payload(a: Json, cloud: boolean): Json {
  const fields = { ...a.fields };
  for (const key of ["description", "environment"] as const)
    if (a[key] !== undefined) {
      if (key in fields)
        throw new ServiceError(
          "invalid_request",
          `${key} 不能同时通过 fields 和内容参数提供`,
        );
      fields[key] = encodeDocument(a[key], cloud);
    }
  return fields;
}
export async function patch(ctx: Execution, a: Json, send: Dispatch) {
  const d = ctx.adapter;
  if (a.expectedUpdated) await d.checkIssue(a.issue, a.expectedUpdated);
  const meta = await d.get(d.issuePath(a.issue) + "/editmeta");
  if (!meta.fields)
    throw new ServiceError("invalid_response", "缺少编辑字段 metadata");
  const fields = payload(a, d.cloud);
  const update: Json = {};
  for (const edit of a.edits ?? []) {
    if (edit.field in fields)
      throw new ServiceError(
        "invalid_request",
        "同一字段不能同时使用 fields 与 edits",
      );
    (update[edit.field] ??= []).push({ [edit.action]: edit.value });
  }
  if (!Object.keys(fields).length && !Object.keys(update).length)
    throw new ServiceError("invalid_request", "没有提供修改字段");
  await d.validateFields(fields, meta.fields, false, update);
  return send("update", "PUT", d.issuePath(a.issue), { fields, update });
}
export async function transition(ctx: Execution, a: Json, send: Dispatch) {
  const d = ctx.adapter;
  if (a.expectedUpdated) await d.checkIssue(a.issue, a.expectedUpdated);
  const transitions = await d.get(
    query(d.issuePath(a.issue) + "/transitions", {
      expand: "transitions.fields",
    }),
  );
  const selected = transitions.transitions?.find(
    (t: Json) => String(t.id) === a.transition,
  );
  if (!selected)
    throw new ServiceError(
      "invalid_transition",
      "此流转当前不可用；先读取 list_transitions",
    );
  await d.validateFields(a.fields ?? {}, selected.fields ?? {}, true);
  return send("transition", "POST", d.issuePath(a.issue) + "/transitions", {
    transition: { id: a.transition },
    fields: a.fields ?? {},
  });
}
