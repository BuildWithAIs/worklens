import type { WriteOperation } from "./schema";
import type { Execution } from "./operation-context";
import type { Page } from "./adapter";
import { ServiceError, type Json } from "./http";
import type { Dispatch } from "./write";
import { storageContent, applyEdits } from "./content";
import { publishMarkdown } from "./transfers";
export async function createPage(
  ctx: Execution,
  a: WriteOperation<"create_page" | "publish_markdown">,
  dispatch: Dispatch,
): Promise<Json> {
  const d = ctx.adapter;
  const h = d.http;
  if (a.operation === "create_page" || a.operation === "publish_markdown") {
    const space = await d.space(a.space);
    if (a.parentId) {
      const parent = await d.page(a.parentId);
      if (String(parent.space) !== String(d.cloud ? space.id : space.key))
        throw new ServiceError("invalid_target", "父页面不属于指定空间");
    }
    if (a.operation === "publish_markdown")
      return publishMarkdown(ctx, a, space, dispatch);
    const storage = storageContent(a.content, a.format);
    return dispatch(async () => {
      const result = await d.create(space, a, storage);
      return {
        status: "success",
        ...result,
        url: h.webUrl(result._links?.webui, result.id),
      };
    });
  }
  throw new ServiceError("not_implemented", "此操作尚未实现");
}
export async function editPage(
  ctx: Execution,
  a: WriteOperation<
    | "edit_page"
    | "replace_page"
    | "append_page"
    | "rename_page"
    | "restore_version"
  >,
  dispatch: Dispatch,
  p: Page,
): Promise<Json> {
  const d = ctx.adapter;
  if (
    a.operation === "edit_page" ||
    a.operation === "replace_page" ||
    a.operation === "append_page" ||
    a.operation === "rename_page" ||
    a.operation === "restore_version"
  ) {
    if (
      ctx.operations.observed.get(ctx.operations.observedKey(ctx, p.id)) !==
      p.version
    )
      throw new ServiceError(
        "read_required",
        "请在当前会话先读取页面当前版本，再准备修改",
      );
    let next = p.storage;
    if (a.operation === "edit_page") next = applyEdits(p.storage, a.edits);
    if (a.operation === "replace_page")
      next = storageContent(a.content, a.format);
    if (a.operation === "append_page")
      next += storageContent(a.content, a.format);
    if (a.operation === "restore_version")
      next = (await d.page(a.page, a.kind, a.version)).storage;
    const title = ("title" in a ? a.title : undefined) ?? p.title;
    d.assertVersion((await d.page(p.id, p.type)).version, p.version);
    return dispatch(async () => ({
      ...(await d.update(
        p,
        next,
        title,
        "message" in a ? a.message : undefined,
        "minorEdit" in a ? a.minorEdit : false,
      )),
      url: p.url,
      previousVersion: p.version,
    }));
  }
  throw new ServiceError("not_implemented", "此操作尚未实现");
}
