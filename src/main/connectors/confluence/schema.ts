import { z } from "zod";
const id = z.string().regex(/^\d+$/).max(80);
const target = z.string().min(1).max(2000);
const text = z.string().max(1_000_000);
const short = z.string().min(1).max(500);
const version = z.number().int().positive();
const page = {
  page: target,
  kind: z.enum(["page", "blogpost"]).default("page"),
};
const paging = {
  limit: z.number().int().min(1).max(100).default(25),
  continuation: z.string().max(200).optional(),
};
const destination = z
  .object({
    directory: target.optional(),
    path: target.optional(),
    overwrite: z.boolean().default(false),
  })
  .strict()
  .refine(
    (v) => !(v.directory && v.path),
    "directory and path are mutually exclusive",
  );
const content = {
  content: text,
  format: z.enum(["markdown", "storage"]).default("markdown"),
};
const op = <const O extends string, T extends z.ZodRawShape>(
  operation: O,
  shape: T,
) => z.object({ operation: z.literal(operation), ...shape }).strict();
export const readOperations = [
  op("capabilities", {}),
  op("describe_operation", { name: short }),
  op("current_user", {}),
  op("read_long_task", { taskId: short }),
  op("list_tasks", {
    assignedTo: short.optional(),
    status: z.enum(["complete", "incomplete"]).optional(),
    ...paging,
  }),
  op("read_task", { taskId: id }),
  op("list_likes", { ...page, ...paging }),
  op("read_space_watch", { space: short }),
  op("list_restriction_subjects", {
    ...page,
    restriction: z.enum(["read", "update"]),
    subjectType: z.enum(["user", "group"]),
    ...paging,
  }),
  op("search", { cql: z.string().min(1).max(10000), ...paging }),
  op("list_spaces", { ...paging }),
  op("read_space", { space: short }),
  op("read_page", {
    ...page,
    status: z
      .enum(["current", "draft", "trashed", "archived"])
      .default("current"),
    version: version.optional(),
    representation: z.enum(["markdown", "storage"]).default("markdown"),
    offset: z.number().int().min(0).default(0),
    length: z.number().int().min(100).max(24000).default(16000),
  }),
  op("list_children", { ...page, ...paging }),
  op("list_ancestors", { ...page, ...paging }),
  op("list_descendants", { ...page, ...paging }),
  op("list_comments", {
    ...page,
    kindOfComment: z.enum(["footer", "inline"]).default("footer"),
    parentCommentId: id.optional(),
    ...paging,
  }),
  op("read_comment", {
    commentId: id,
    kindOfComment: z.enum(["footer", "inline"]).default("footer"),
  }),
  op("list_versions", { ...page, ...paging }),
  op("compare_versions", { ...page, from: version, to: version }),
  op("list_labels", { ...page, ...paging }),
  op("list_attachments", { ...page, ...paging }),
  op("read_attachment", { attachmentId: id }),
  op("download_attachment", {
    attachmentId: id,
    destination: destination.optional(),
  }),
  op("export_page", {
    ...page,
    format: z.enum(["markdown", "html"]).default("markdown"),
    attachmentIds: z.array(id).max(30).default([]),
    destination: destination.optional(),
  }),
  op("read_restrictions", { ...page, ...paging }),
  op("read_operations", { ...page }),
  op("list_properties", { ...page, ...paging }),
  op("read_property", { ...page, key: short }),
  op("list_templates", { space: short, ...paging }),
  op("read_template", { templateId: short }),
  op("search_users", { query: short, ...paging }),
  op("list_groups", { ...paging }),
  op("list_group_members", { group: short, ...paging }),
  op("read_watch", { ...page }),
] as const;
const expected = { expectedVersion: version };
const comment = {
  commentId: id,
  kindOfComment: z.enum(["footer", "inline"]).default("footer"),
};
export const writeOperations = [
  op("create_page", {
    space: short,
    parentId: id.optional(),
    title: short,
    kind: z.enum(["page", "blogpost"]).default("page"),
    status: z.enum(["current", "draft"]).default("current"),
    ...content,
  }),
  op("edit_page", {
    ...page,
    ...expected,
    title: short.optional(),
    edits: z
      .array(
        z
          .object({
            find: z.string().min(1).max(100000),
            replace: text,
            expectedMatches: z.number().int().min(1).max(100).default(1),
          })
          .strict(),
      )
      .min(1)
      .max(30),
    message: short.optional(),
    minorEdit: z.boolean().default(false),
  }),
  op("append_page", {
    ...page,
    ...expected,
    ...content,
    message: short.optional(),
    minorEdit: z.boolean().default(false),
  }),
  op("replace_page", {
    ...page,
    ...expected,
    ...content,
    title: short.optional(),
    message: short.optional(),
    minorEdit: z.boolean().default(false),
  }),
  op("rename_page", { ...page, ...expected, title: short }),
  op("restore_version", { ...page, ...expected, version }),
  op("move_page", {
    ...page,
    ...expected,
    targetId: id,
    position: z.enum(["append", "before", "after"]).default("append"),
  }),
  op("trash_page", { ...page, ...expected }),
  op("restore_page", { ...page, ...expected }),
  op("delete_page_permanently", { ...page, ...expected }),
  op("archive_page", { ...page, ...expected }),
  op("copy_page", {
    ...page,
    ...expected,
    parentId: id,
    title: short,
    copyAttachments: z.boolean().default(false),
    copyLabels: z.boolean().default(false),
    copyRestrictions: z.boolean().default(true),
  }),
  op("add_comment", {
    ...page,
    ...content,
    parentCommentId: id.optional(),
    kindOfComment: z.enum(["footer", "inline"]).default("footer"),
  }),
  op("edit_comment", { ...comment, ...expected, ...content }),
  op("delete_comment", { ...comment, ...expected }),
  op("add_inline_comment", {
    ...page,
    ...expected,
    ...content,
    selection: z.string().min(1).max(5000),
    matchIndex: z.number().int().min(0),
    expectedMatches: z.number().int().positive(),
  }),
  op("resolve_comment", { ...comment, ...expected, resolved: z.boolean() }),
  op("add_labels", { ...page, labels: z.array(short).min(1).max(50) }),
  op("remove_label", { ...page, label: short }),
  op("upload_attachment", {
    ...page,
    filePath: target,
    attachmentId: id.optional(),
    expectedVersion: version.optional(),
    comment: z.string().max(1000).optional(),
  }),
  op("delete_attachment", { attachmentId: id, ...expected }),
  op("publish_markdown", {
    space: short,
    parentId: id,
    title: short,
    filePath: target,
    assets: z
      .array(z.object({ reference: short, filePath: target }).strict())
      .max(30)
      .default([]),
  }),
  op("set_watch", { ...page, watching: z.boolean() }),
  op("set_space_watch", { space: short, watching: z.boolean() }),
  op("set_task_status", {
    taskId: id,
    expectedStatus: z.enum(["complete", "incomplete"]),
    status: z.enum(["complete", "incomplete"]),
  }),
  op("set_property", {
    ...page,
    key: short,
    value: z.json(),
    expectedVersion: z.number().int().min(0),
  }),
  op("delete_property", { ...page, key: short, ...expected }),
  op("add_restriction", {
    ...page,
    restriction: z.enum(["read", "update"]),
    subject: z.object({ type: z.enum(["user", "group"]), id: short }).strict(),
  }),
  op("remove_restriction", {
    ...page,
    restriction: z.enum(["read", "update"]),
    subject: z.object({ type: z.enum(["user", "group"]), id: short }).strict(),
  }),
] as const;
export const readSchema = z
  .object({ request: z.union(readOperations) })
  .strict();
export const writeSchema = z
  .object({ request: z.union(writeOperations) })
  .strict();
export type ReadRequest = z.infer<typeof readSchema>["request"];
export type WriteRequest = z.infer<typeof writeSchema>["request"];
export type WriteOperation<O extends WriteRequest["operation"]> = Extract<
  WriteRequest,
  { operation: O }
>;
