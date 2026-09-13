import type { WriteOperation } from "./schema";
import type { Execution } from "./operation-context";
import type { Page } from "./adapter";
import { ServiceError, type Json } from "./http";
import type { Dispatch } from "./write";
import { storageContent, readableStorage } from "./content";
export async function updateComment(
  ctx: Execution,
  a: WriteOperation<"edit_comment" | "delete_comment" | "resolve_comment">,
  dispatch: Dispatch,
): Promise<Json> {
  const d = ctx.adapter;
  const h = d.http;
  const approve = (detail: Json, target = a.commentId) =>
    ctx.operations.approve(ctx, a.operation, String(target), detail);
  if (
    a.operation === "edit_comment" ||
    a.operation === "delete_comment" ||
    a.operation === "resolve_comment"
  ) {
    if (!d.cloud && a.kindOfComment === "inline")
      throw new ServiceError(
        "not_implemented",
        "Data Center 行内评论写入尚未实现",
      );
    const comment = await d.comment(a.commentId, a.kindOfComment);
    d.assertVersion(comment.version?.number, a.expectedVersion);
    const body =
      a.operation === "edit_comment"
        ? storageContent(a.content, a.format)
        : comment.body?.storage?.value;
    await approve({
      commentId: a.commentId,
      version: a.expectedVersion,
      before: comment.body,
      after: body,
      resolved: a.operation === "resolve_comment" ? a.resolved : undefined,
    });
    const latest = await d.comment(a.commentId, a.kindOfComment);
    d.assertVersion(latest.version?.number, a.expectedVersion);
    if (
      a.operation === "resolve_comment" &&
      (a.kindOfComment !== "inline" || !d.cloud)
    )
      throw new ServiceError(
        "not_implemented",
        "仅 Cloud 行内评论支持解决或重新打开",
      );
    const endpoint = d.cloud
      ? d.v2(`/${a.kindOfComment}-comments/${a.commentId}`)
      : d.v1(`/content/${a.commentId}`);
    return dispatch(() =>
      h.json(
        endpoint,
        a.operation === "delete_comment" ? "DELETE" : "PUT",
        a.operation === "delete_comment"
          ? undefined
          : d.cloud
            ? {
                version: { number: a.expectedVersion + 1 },
                body: { representation: "storage", value: body },
                ...(a.operation === "resolve_comment"
                  ? { resolved: a.resolved }
                  : {}),
              }
            : {
                type: "comment",
                version: { number: a.expectedVersion + 1 },
                body: { storage: { representation: "storage", value: body } },
              },
      ),
    );
  }
  throw new ServiceError("not_implemented", "此操作尚未实现");
}
export async function addComment(
  ctx: Execution,
  a: WriteOperation<"add_comment" | "add_inline_comment">,
  dispatch: Dispatch,
  p: Page,
): Promise<Json> {
  const parentCommentId =
    a.operation === "add_comment" ? a.parentCommentId : undefined;
  const kindOfComment =
    a.operation === "add_comment" ? a.kindOfComment : "inline";
  const d = ctx.adapter;
  const h = d.http;
  const approve = (detail: Json, target = p.id) =>
    ctx.operations.approve(ctx, a.operation, String(target), detail);
  if (a.operation === "add_comment" || a.operation === "add_inline_comment") {
    const body = storageContent(a.content, a.format);
    if (
      a.operation === "add_comment" &&
      kindOfComment === "inline" &&
      (!d.cloud || !parentCommentId)
    )
      throw new ServiceError(
        "invalid_request",
        "行内回复需要 Cloud 和 parentCommentId；新建选区评论请使用 add_inline_comment",
      );
    if (parentCommentId) {
      const parent = await d.comment(
        parentCommentId,
        kindOfComment ?? "footer",
      );
      const parentPage =
        parent.pageId ?? parent.blogPostId ?? parent.container?.id;
      if (String(parentPage) !== p.id)
        throw new ServiceError("invalid_target", "父评论不属于指定页面");
    }
    if (a.operation === "add_inline_comment") {
      if (!d.cloud)
        throw new ServiceError(
          "not_implemented",
          "Data Center 行内评论创建尚未实现",
        );
      const plain = readableStorage(p.storage, p.url).markdown;
      const count = plain.split(a.selection).length - 1;
      if (count !== a.expectedMatches || a.matchIndex >= count)
        throw new ServiceError(
          "ambiguous_anchor",
          "评论选区匹配不明确，请重新选择",
        );
    }
    await approve({
      page: p.title,
      body,
      parentCommentId: parentCommentId,
      selection: a.operation === "add_inline_comment" ? a.selection : undefined,
    });
    if (a.operation === "add_inline_comment")
      d.assertVersion((await d.page(p.id, p.type)).version, p.version);
    return dispatch(() =>
      h.json(
        d.cloud
          ? d.v2(
              a.operation === "add_inline_comment" || kindOfComment === "inline"
                ? "/inline-comments"
                : "/footer-comments",
            )
          : d.v1("/content"),
        "POST",
        d.cloud
          ? {
              [p.type === "blogpost" ? "blogPostId" : "pageId"]: p.id,
              ...(parentCommentId ? { parentCommentId: parentCommentId } : {}),
              body: { representation: "storage", value: body },
              ...(a.operation === "add_inline_comment"
                ? {
                    inlineCommentProperties: {
                      textSelection: a.selection,
                      textSelectionMatchCount: a.expectedMatches,
                      textSelectionMatchIndex: a.matchIndex,
                    },
                  }
                : {}),
            }
          : {
              type: "comment",
              container: { id: p.id, type: p.type },
              ...(parentCommentId
                ? { ancestors: [{ id: parentCommentId }] }
                : {}),
              body: { storage: { representation: "storage", value: body } },
            },
      ),
    );
  }
  throw new ServiceError("not_implemented", "此操作尚未实现");
}
