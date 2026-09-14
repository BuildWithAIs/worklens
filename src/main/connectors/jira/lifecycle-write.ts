import type { Execution } from "./context";
import { ServiceError, type Json } from "./http";
import { segment } from "./adapter";
import { MAX_FILE_BYTES } from "../../local-artifacts";
import type { Dispatch } from "./write";

export async function clone(
  ctx: Execution,
  a: Json,
  send: Dispatch,
): Promise<Json> {
  const d = ctx.adapter;
  const source = await d.issue(a.issue);
  const selected: Json = {};
  for (const key of a.copyFields) {
    if (
      [
        "project",
        "issuetype",
        "summary",
        "attachment",
        "issuelinks",
        "comment",
        "worklog",
        "status",
        "created",
        "updated",
        "resolution",
      ].includes(key)
    )
      throw new ServiceError(
        "invalid_field",
        `不能通过 copyFields 复制 ${key}`,
      );
    if (!(key in source.fields))
      throw new ServiceError("invalid_field", `源工单没有字段 ${key}`);
    selected[key] = source.fields[key];
  }
  const fields = {
    ...selected,
    ...a.overrides,
    project: /^\d+$/.test(a.project) ? { id: a.project } : { key: a.project },
    issuetype: { id: a.issueType },
    summary: a.summary,
  };
  const meta = await d.metadata(a.project, a.issueType);
  await d.validateFields(
    fields,
    { ...meta, project: meta.project ?? {}, issuetype: meta.issuetype ?? {} },
    true,
  );
  const created = await send("clone:create", "POST", d.api + "/issue", {
    fields,
  });
  if (!created.key)
    throw new ServiceError("unknown", "创建响应缺少工单 key，请先核实");
  const results: Json[] = [
    { step: "create", status: "success", key: created.key },
  ];
  const tasks: { name: string; execute: () => Promise<Json> }[] = [];
  if (a.copyLinks)
    for (const link of source.fields.issuelinks ?? [])
      tasks.push({
        name: "link:" + link.id,
        execute: () =>
          send("clone:link:" + link.id, "POST", d.api + "/issueLink", {
            type: { id: link.type.id },
            inwardIssue: {
              key: link.outwardIssue ? created.key : link.inwardIssue.key,
            },
            outwardIssue: {
              key: link.outwardIssue ? link.outwardIssue.key : created.key,
            },
          }),
      });
  if (a.copyAttachments)
    for (const file of source.fields.attachment ?? [])
      tasks.push({
        name: "attachment:" + file.id,
        execute: async () => {
          if (file.size > MAX_FILE_BYTES) throw new Error("附件超过 100 MiB");
          const response = await d.http.download(
            d.cloud
              ? `${d.api}/attachment/content/${segment(file.id)}`
              : `/secure/attachment/${segment(file.id)}/${segment(file.filename)}`,
          );
          const chunks: Uint8Array[] = [];
          let size = 0;
          if (!response.body) throw new Error("附件为空");
          for await (const bytes of response.body as unknown as AsyncIterable<Uint8Array>) {
            size += bytes.length;
            if (size > MAX_FILE_BYTES) throw new Error("附件超过 100 MiB");
            chunks.push(bytes);
          }
          const form = new FormData();
          form.append("file", new Blob(chunks as BlobPart[]), file.filename);
          return send(
            "clone:attachment:" + file.id,
            "POST",
            d.issuePath(created.key) + "/attachments",
            form,
          );
        },
      });
  for (const task of tasks) {
    try {
      const result = await task.execute();
      results.push({ step: task.name, status: "success", result });
    } catch (error) {
      results.push({
        step: task.name,
        status:
          error instanceof ServiceError
            ? error.code
            : ctx.signal.aborted
              ? "not_executed"
              : "failed",
        message: String(error),
      });
    }
  }
  return {
    status: results.every((r) => r.status === "success")
      ? "success"
      : "partial",
    key: created.key,
    url: d.http.webUrl(created.key),
    results,
    retry:
      "Keep the created issue; retry only failed attachments/links using their individual operations, never clone again.",
  };
}
