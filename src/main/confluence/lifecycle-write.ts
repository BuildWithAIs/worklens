import type { WriteOperation } from "./schema";
import type { Execution } from "./operation-context";
import type { Page } from "./adapter";
import { ServiceError, type Json } from "./http";
import type { Dispatch } from "./write";

export async function writeLifecycle(
  ctx: Execution,
  a: WriteOperation<
    | "move_page"
    | "copy_page"
    | "archive_page"
    | "trash_page"
    | "delete_page_permanently"
    | "restore_page"
  >,
  dispatch: Dispatch,
  p: Page,
): Promise<Json> {
  const d = ctx.adapter;
  const h = d.http;
  const approve = (detail: Json, target = p.id) =>
    ctx.operations.approve(ctx, a.operation, String(target), detail);
  if (a.operation === "move_page") {
    const target = await d.page(a.targetId);
    if (p.id === target.id)
      throw new ServiceError("invalid_target", "不能移动到自身");
    const restrictions = await h.json(
      d.v1(`/content/${p.id}/restriction/byOperation`),
    );
    const targetRestrictions = await h.json(
      d.v1(`/content/${target.id}/restriction/byOperation`),
    );
    await approve({
      page: p.title,
      target: target.title,
      position: a.position,
      restrictions,
      targetRestrictions,
      note: "移动会改变页面树及继承访问范围；子页面随父页面移动。",
    });
    d.assertVersion((await d.page(p.id)).version, p.version);
    return dispatch(() =>
      h.json(d.v1(`/content/${p.id}/move/${a.position}/${target.id}`), "PUT"),
    );
  }
  if (a.operation === "copy_page") {
    if (!d.cloud)
      throw new ServiceError(
        "not_implemented",
        "Data Center 原生页面复制尚未实现；不会以有损读写代替复制",
      );
    const parent = await d.page(a.parentId);
    await approve({
      source: p.title,
      parent: parent.title,
      title: a.title,
      copyAttachments: a.copyAttachments,
      copyLabels: a.copyLabels,
      copyRestrictions: a.copyRestrictions,
      note: "目标父页面的继承权限仍然生效。",
    });
    return dispatch(async () => ({
      status: "success",
      page: await h.json(d.v1(`/content/${p.id}/copy`), "POST", {
        copyAttachments: a.copyAttachments,
        copyLabels: a.copyLabels,
        copyPermissions: a.copyRestrictions,
        destination: { type: "parent_page", value: parent.id },
        pageTitle: a.title,
      }),
    }));
  }
  if (a.operation === "archive_page") {
    if (!d.cloud)
      throw new ServiceError("not_implemented", "Data Center 页面归档尚未实现");
    await approve({ page: p.title, version: p.version });
    return dispatch(async () => ({
      status: "accepted",
      task: await h.json(d.v1("/content/archive"), "POST", {
        pages: [{ id: p.id }],
      }),
    }));
  }
  if (
    a.operation === "trash_page" ||
    a.operation === "delete_page_permanently" ||
    a.operation === "restore_page"
  ) {
    const descendants = await h.json(
      d.cloud
        ? d.v2(`/pages/${p.id}/descendants?limit=100`)
        : d.v1(`/content/${p.id}/descendant/page?limit=100`),
    );
    if (descendants.results?.length || descendants._links?.next)
      throw new ServiceError(
        "descendants_present",
        "页面含子页面，请先明确并处理子页面范围，再操作此页面",
      );
    await approve({
      page: p.title,
      version: p.version,
      permanent: a.operation === "delete_page_permanently",
      action: a.operation,
    });
    if (a.operation === "restore_page")
      return dispatch(() =>
        h.json(
          d.cloud
            ? d.v2(`/${d.collection(p.type)}/${p.id}`)
            : d.v1(`/content/${p.id}`),
          "PUT",
          d.cloud
            ? {
                id: p.id,
                status: "current",
                title: p.title,
                version: { number: p.version + 1 },
                body: { representation: "storage", value: p.storage },
              }
            : {
                type: p.type,
                status: "current",
                title: p.title,
                version: { number: p.version + 1 },
              },
        ),
      );
    return dispatch(() =>
      h.json(
        d.cloud
          ? d.v2(
              `/${d.collection(p.type)}/${p.id}${a.operation === "delete_page_permanently" ? "?purge=true" : ""}`,
            )
          : d.v1(
              `/content/${p.id}${a.operation === "delete_page_permanently" ? "?status=trashed" : ""}`,
            ),
        "DELETE",
      ),
    );
  }
  throw new ServiceError("not_implemented", "此操作尚未实现");
}
