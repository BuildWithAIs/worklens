import { assertNever } from "./list-results";
import type { WriteRequest } from "./schema";
import type { Execution } from "./operation-context";
import type { Json } from "./http";
import { createPage, editPage } from "./page-write";
import { updateComment, addComment } from "./comment-write";
import { deleteAttachment, uploadAttachment } from "./attachment-write";
import {
  writeServiceCollaboration,
  writePageCollaboration,
} from "./collaboration-write";
import { writeLifecycle } from "./lifecycle-write";
export type Dispatch = (fn: () => Promise<Json>) => Promise<Json>;
export async function write(
  ctx: Execution,
  a: WriteRequest,
  dispatch: Dispatch,
): Promise<Json> {
  switch (a.operation) {
    case "create_page":
    case "publish_markdown":
      return createPage(ctx, a, dispatch);
    case "edit_comment":
    case "delete_comment":
    case "resolve_comment":
      return updateComment(ctx, a, dispatch);
    case "delete_attachment":
      return deleteAttachment(ctx, a, dispatch);
    case "set_space_watch":
    case "set_task_status":
      return writeServiceCollaboration(ctx, a, dispatch);
  }
  const d = ctx.adapter;
  const p = await d.page(
    a.page,
    a.kind,
    undefined,
    ["restore_page", "delete_page_permanently"].includes(a.operation)
      ? "trashed"
      : "current",
  );
  if (
    "expectedVersion" in a &&
    a.expectedVersion &&
    !["upload_attachment", "set_property", "delete_property"].includes(
      a.operation,
    )
  )
    d.assertVersion(p.version, a.expectedVersion);
  switch (a.operation) {
    case "edit_page":
    case "replace_page":
    case "append_page":
    case "rename_page":
    case "restore_version":
      return editPage(ctx, a, dispatch, p);
    case "add_comment":
    case "add_inline_comment":
      return addComment(ctx, a, dispatch, p);
    case "upload_attachment":
      return uploadAttachment(ctx, a, dispatch, p);
    case "add_labels":
    case "remove_label":
    case "set_watch":
    case "set_property":
    case "delete_property":
    case "add_restriction":
    case "remove_restriction":
      return writePageCollaboration(ctx, a, dispatch, p);
    case "move_page":
    case "copy_page":
    case "archive_page":
    case "trash_page":
    case "delete_page_permanently":
    case "restore_page":
      return writeLifecycle(ctx, a, dispatch, p);
    default:
      return assertNever(a);
  }
}
