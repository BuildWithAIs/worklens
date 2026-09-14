import { z } from "zod";

const id = z
  .string()
  .trim()
  .min(1)
  .max(250)
  .regex(/^[\w-]+$/);
const numericId = z
  .string()
  .regex(/^[1-9]\d*$/)
  .max(30);
const userId = z
  .string()
  .trim()
  .min(1)
  .max(250)
  .regex(/^[^\s/\\?#]+$/)
  .describe(
    "Exact Cloud accountId or Data Center username; resolve with search_users/assignable_users",
  );
const target = z.string().trim().min(1).max(2000);
const text = z.string().max(500_000);
const page = {
  limit: z.number().int().min(1).max(100).default(50),
  continuation: z.string().uuid().optional(),
};
const issue = { issue: target };
const project = { project: id };
const document = z.discriminatedUnion("format", [
  z.object({ format: z.literal("markdown"), text }).strict(),
  z.object({ format: z.literal("wiki"), text }).strict(),
  z
    .object({
      format: z.literal("adf"),
      value: z
        .object({
          type: z.literal("doc"),
          version: z.literal(1),
          content: z.array(z.json()),
        })
        .strict(),
    })
    .strict(),
]);
const visibility = z
  .object({
    type: z.enum(["group", "role"]),
    value: z.string().min(1).max(250),
  })
  .strict();
const fields = z
  .record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/), z.json())
  .describe(
    "Jira field IDs mapped to native values; use create_metadata/edit_metadata first. null explicitly clears; omitted fields stay unchanged. User values use accountId on Cloud, name on DC.",
  );
const edits = z
  .array(
    z
      .object({
        field: id,
        action: z.enum(["set", "add", "remove"]),
        value: z.json(),
      })
      .strict(),
  )
  .min(1)
  .max(100);
const contentFields = {
  description: document.optional(),
  environment: document.optional(),
};
const expected = {
  expectedUpdated: z
    .string()
    .min(1)
    .optional()
    .describe(
      "From read_issue; fails preflight if changed. Jira does not universally provide atomic version checks.",
    ),
};
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const instant = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:?\d{2})$/,
  )
  .refine((v) => Number.isFinite(Date.parse(v)), "Invalid timestamp");
const estimate = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("leave") }).strict(),
  z.object({ mode: z.literal("auto") }).strict(),
  z
    .object({
      mode: z.literal("new"),
      remaining: z.string().regex(/^(?:\d+[wdhm]\s*)+$/),
    })
    .strict(),
]);
const worklog = {
  started: instant,
  timeSpentSeconds: z.number().int().min(1).max(315360000),
  comment: document.optional(),
  visibility: visibility.optional(),
};
const destination = z
  .object({
    directory: target.optional(),
    path: target.optional(),
    overwrite: z.boolean().optional(),
  })
  .strict()
  .refine((v) => !(v.path && v.directory), "Choose path or directory");
function op<const N extends string, S extends z.ZodRawShape>(
  name: N,
  shape: S,
) {
  return z.object({ operation: z.literal(name), ...shape }).strict();
}
const batchItem = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("update"),
      ...issue,
      fields: fields.optional(),
      edits: edits.optional(),
      ...contentFields,
      ...expected,
    })
    .strict(),
  z
    .object({
      action: z.literal("transition"),
      ...issue,
      transition: id,
      fields: fields.optional(),
      ...expected,
    })
    .strict(),
]);
export const readOperations = [
  op("capabilities", {}),
  op("read_operation", { operationId: z.string().regex(/^[a-f0-9]{64}$/) }),
  op("describe_operation", { name: id }),
  op("current_user", {}),
  op("server_info", {}),
  op("permissions", {
    project: id.optional(),
    issue: target.optional(),
    permissions: z.array(id).min(1).max(100),
  }),
  op("list_projects", { ...page }),
  op("read_project", project),
  op("list_fields", { ...page }),
  op("list_issue_types", { ...project, ...page }),
  op("create_metadata", { ...project, issueType: numericId, ...page }),
  op("edit_metadata", issue),
  op("list_priorities", { ...page }),
  op("list_resolutions", { ...page }),
  op("list_link_types", {}),
  op("list_components", { ...project, ...page }),
  op("read_component", { component: numericId }),
  op("list_versions", { ...project, ...page }),
  op("read_version", { version: numericId }),
  op("search_users", { query: z.string().min(1).max(250), ...page }),
  op("assignable_users", {
    query: z.string().max(250).default(""),
    project: id.optional(),
    issue: target.optional(),
    ...page,
  }),
  op("search", {
    jql: z.string().min(1).max(16000),
    fields: z.array(id).max(100).optional(),
    ...page,
  }),
  op("read_issue", { ...issue, fields: z.array(id).max(100).optional() }),
  op("list_comments", { ...issue, ...page }),
  op("read_comment", { ...issue, comment: numericId }),
  op("changelog", { ...issue, ...page }),
  op("list_worklogs", { ...issue, ...page }),
  op("read_worklog", { ...issue, worklog: numericId }),
  op("list_transitions", issue),
  op("list_remote_links", { ...issue, ...page }),
  op("list_watchers", issue),
  op("read_votes", issue),
  op("list_attachments", issue),
  op("attachment_settings", {}),
  op("read_attachment", { attachment: numericId }),
  op("download_attachment", {
    attachment: numericId,
    destination: destination.optional(),
  }),
  op("list_filters", {
    kind: z.enum(["favourite", "my", "search"]).default("favourite"),
    query: z.string().max(250).optional(),
    ...page,
  }),
  op("read_filter", { filter: numericId }),
  op("run_filter", { filter: numericId, ...page }),
  op("list_boards", {
    project: id.optional(),
    type: z.enum(["scrum", "kanban"]).optional(),
    ...page,
  }),
  op("read_board", { board: numericId }),
  op("board_configuration", { board: numericId }),
  op("backlog", { board: numericId, ...page }),
  op("board_issues", { board: numericId, ...page }),
  op("list_sprints", {
    board: numericId,
    state: z.enum(["active", "future", "closed"]).optional(),
    ...page,
  }),
  op("read_sprint", { sprint: numericId }),
  op("sprint_issues", { sprint: numericId, ...page }),
  op("preview_delete", issue),
  op("preview_batch", { items: z.array(batchItem).min(1).max(50) }),
] as const;
export const writeOperations = [
  op("create_issue", {
    ...project,
    issueType: numericId,
    fields,
    ...contentFields,
  }),
  op("update_issue", {
    ...issue,
    fields: fields.optional(),
    edits: edits.optional(),
    ...contentFields,
    ...expected,
  }),
  op("transition_issue", {
    ...issue,
    transition: id,
    fields: fields.optional(),
    ...expected,
  }),
  op("assign_issue", { ...issue, user: userId.nullable(), ...expected }),
  op("set_parent", {
    ...issue,
    parent: target.nullable(),
    field: id.default("parent"),
    ...expected,
  }),
  op("clone_issue", {
    ...issue,
    ...project,
    issueType: numericId,
    summary: z.string().min(1).max(255),
    copyFields: z.array(id).max(100),
    copyLinks: z.boolean(),
    copyAttachments: z.boolean(),
    overrides: fields.optional(),
  }),
  op("delete_issue", {
    ...issue,
    preview: z.string().uuid(),
    deleteSubtasks: z.boolean(),
  }),
  op("add_comment", {
    ...issue,
    body: document,
    visibility: visibility.optional(),
  }),
  op("edit_comment", {
    ...issue,
    comment: numericId,
    body: document,
    visibility: visibility.nullable().optional(),
    expectedUpdated: z.string().min(1),
  }),
  op("delete_comment", {
    ...issue,
    comment: numericId,
    expectedUpdated: z.string().min(1),
  }),
  op("link_issues", {
    ...issue,
    other: target,
    type: id,
    direction: z.enum(["outward", "inward"]),
  }),
  op("unlink_issues", { ...issue, link: numericId }),
  op("set_remote_link", {
    ...issue,
    link: numericId.optional(),
    url: z.url(),
    title: z.string().min(1).max(1000),
    relationship: z.string().max(250).optional(),
  }),
  op("delete_remote_link", { ...issue, link: numericId }),
  op("set_watch", { ...issue, watching: z.boolean(), user: userId.optional() }),
  op("set_vote", { ...issue, voting: z.boolean() }),
  op("upload_attachment", { ...issue, filePath: target }),
  op("delete_attachment", { ...issue, attachment: numericId }),
  op("add_worklog", { ...issue, ...worklog, estimate }),
  op("edit_worklog", {
    ...issue,
    worklog: numericId,
    ...worklog,
    estimate,
    expectedUpdated: z.string().min(1),
  }),
  op("delete_worklog", {
    ...issue,
    worklog: numericId,
    estimate,
    expectedUpdated: z.string().min(1),
  }),
  op("create_filter", {
    name: z.string().min(1).max(255),
    jql: z.string().min(1).max(16000),
    description: z.string().max(5000).optional(),
    favourite: z.boolean().default(false),
  }),
  op("update_filter", {
    filter: numericId,
    name: z.string().min(1).max(255).optional(),
    jql: z.string().min(1).max(16000).optional(),
    description: z.string().max(5000).optional(),
  }),
  op("delete_filter", { filter: numericId }),
  op("set_filter_favourite", { filter: numericId, favourite: z.boolean() }),
  op("move_to_sprint", {
    sprint: numericId,
    issues: z.array(target).min(1).max(50),
  }),
  op("move_to_backlog", { issues: z.array(target).min(1).max(50) }),
  op("rank_issues", {
    issues: z.array(target).min(1).max(50),
    before: target.optional(),
    after: target.optional(),
    board: numericId,
  }),
  op("set_estimate", {
    ...issue,
    board: numericId,
    value: z.number().nonnegative(),
  }),
  op("create_sprint", {
    board: numericId,
    name: z.string().min(1).max(255),
    goal: z.string().max(10000).optional(),
    startDate: instant.optional(),
    endDate: instant.optional(),
  }),
  op("update_sprint", {
    sprint: numericId,
    name: z.string().min(1).max(255).optional(),
    goal: z.string().max(10000).optional(),
    startDate: instant.optional(),
    endDate: instant.optional(),
  }),
  op("start_sprint", {
    sprint: numericId,
    startDate: instant,
    endDate: instant,
  }),
  op("complete_sprint", {
    sprint: numericId,
    board: numericId,
    unfinished: z.discriminatedUnion("destination", [
      z.object({ destination: z.literal("backlog") }).strict(),
      z
        .object({ destination: z.literal("sprint"), sprint: numericId })
        .strict(),
    ]),
  }),
  op("create_version", {
    ...project,
    name: z.string().min(1).max(255),
    description: z.string().max(10000).optional(),
    startDate: date.optional(),
    releaseDate: date.optional(),
  }),
  op("update_version", {
    version: numericId,
    name: z.string().min(1).max(255).optional(),
    description: z.string().max(10000).optional(),
    startDate: date.optional(),
    releaseDate: date.optional(),
    released: z.boolean().optional(),
    archived: z.boolean().optional(),
  }),
  op("release_version", { version: numericId, releaseDate: date }),
  op("batch", {
    items: z.array(batchItem).min(1).max(50),
    preview: z.string().uuid().optional(),
  }),
] as const;
export type ReadRequest = z.infer<(typeof readOperations)[number]>;
export type WriteRequest = z.infer<(typeof writeOperations)[number]>;
export type DocumentInput = z.infer<typeof document>;
export function parseRequest(
  raw: unknown,
  write: boolean,
): ReadRequest | WriteRequest {
  const envelope = z
    .object({ request: z.object({ operation: z.string() }).passthrough() })
    .strict()
    .parse(raw);
  const schema = [...(write ? writeOperations : readOperations)].find(
    (s) => s.shape.operation.value === envelope.request.operation,
  );
  if (!schema)
    throw new Error(
      "未知操作；使用 capabilities 和 describe_operation 查看参数",
    );
  return schema.parse(envelope.request);
}
export function describeOperation(name: string) {
  const schema = [...readOperations, ...writeOperations].find(
    (s) => s.shape.operation.value === name,
  );
  if (!schema) throw new Error("Unknown Jira operation");
  return {
    name,
    inputSchema: z.toJSONSchema(z.object({ request: schema }).strict(), {
      target: "draft-7",
      io: "input",
    }),
  };
}
export function discoverySchema(write: boolean) {
  return {
    type: "object",
    properties: {
      request: {
        type: "object",
        properties: {
          operation: {
            type: "string",
            enum: (write ? writeOperations : readOperations).map(
              (s) => s.shape.operation.value,
            ),
          },
          ...(!write ? { name: { type: "string" } } : {}),
        },
        required: ["operation"],
        additionalProperties: true,
      },
    },
    required: ["request"],
    additionalProperties: false,
  };
}
