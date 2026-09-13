import type { WriteOperation } from "./schema";
import type { Execution } from "./operation-context";
import type { Page } from "./adapter";
import { ServiceError, type Json } from "./http";
import type { Dispatch } from "./write";
import { uploadFile } from "./transfers";
export async function deleteAttachment(
  ctx: Execution,
  a: WriteOperation<"delete_attachment">,
  dispatch: Dispatch,
): Promise<Json> {
  const d = ctx.adapter;
  const h = d.http;
  const approve = (detail: Json, target = a.attachmentId) =>
    ctx.operations.approve(ctx, a.operation, String(target), detail);
  if (a.operation === "delete_attachment") {
    const attachment = await d.attachment(a.attachmentId);
    d.assertVersion(attachment.version?.number, a.expectedVersion);
    await approve({
      attachmentId: a.attachmentId,
      title: attachment.title,
      version: a.expectedVersion,
    });
    d.assertVersion(
      (await d.attachment(a.attachmentId)).version?.number,
      a.expectedVersion,
    );
    return dispatch(() =>
      h.json(
        d.cloud
          ? d.v2(`/attachments/${a.attachmentId}`)
          : d.v1(`/content/${a.attachmentId}`),
        "DELETE",
      ),
    );
  }
  throw new ServiceError("not_implemented", "此操作尚未实现");
}
export async function uploadAttachment(
  ctx: Execution,
  a: WriteOperation<"upload_attachment">,
  dispatch: Dispatch,
  p: Page,
): Promise<Json> {
  const d = ctx.adapter;
  const h = d.http;
  const approve = (detail: Json, target = p.id) =>
    ctx.operations.approve(ctx, a.operation, String(target), detail);
  if (a.operation === "upload_attachment") {
    const file = await uploadFile(ctx, a.filePath);
    if (a.attachmentId) {
      const attachment = await d.attachment(a.attachmentId);
      if (
        String(
          attachment.pageId ??
            attachment.blogPostId ??
            attachment.container?.id,
        ) !== p.id
      )
        throw new ServiceError("invalid_target", "附件不属于指定页面");
      if (!a.expectedVersion)
        throw new ServiceError(
          "invalid_request",
          "更新附件需要 expectedVersion",
        );
      d.assertVersion(attachment.version?.number, a.expectedVersion);
    } else {
      const existing = await h.json(
        d.v1(
          `/content/${p.id}/child/attachment?filename=${encodeURIComponent(file.name)}&limit=2`,
        ),
      );
      if (!Array.isArray(existing.results))
        throw new ServiceError("invalid_response", "无法确认同名附件是否存在");
      if (existing.results.length)
        throw new ServiceError(
          "attachment_exists",
          "同名附件已存在；更新时请明确指定 attachmentId 和 expectedVersion",
        );
    }
    await approve({
      page: p.title,
      filePath: ctx.operations.artifacts.resolvePath(a.filePath),
      filename: file.name,
      size: file.blob.size,
      attachmentId: a.attachmentId,
    });
    if (a.attachmentId && a.expectedVersion)
      d.assertVersion(
        (await d.attachment(a.attachmentId)).version?.number,
        a.expectedVersion,
      );
    return dispatch(() =>
      d.upload(p.id, file.name, file.blob, a.attachmentId, a.comment),
    );
  }
  throw new ServiceError("not_implemented", "此操作尚未实现");
}
