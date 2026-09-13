import type { WriteOperation } from "./schema";
import type { Execution } from "./operation-context";
import type { Page } from "./adapter";
import { ServiceError, type Json } from "./http";
import type { Dispatch } from "./write";

export async function writeServiceCollaboration(
  ctx: Execution,
  a: WriteOperation<"set_space_watch" | "set_task_status">,
  dispatch: Dispatch,
): Promise<Json> {
  const d = ctx.adapter;
  const h = d.http;
  const approve = (
    detail: Json,
    target = a.operation === "set_space_watch" ? a.space : a.taskId,
  ) => ctx.operations.approve(ctx, a.operation, String(target), detail);
  if (a.operation === "set_space_watch") {
    const space = await d.space(a.space);
    await approve({ space: space.name, watching: a.watching });
    return dispatch(() =>
      h.json(
        d.v1(`/user/watch/space/${encodeURIComponent(space.key)}`),
        a.watching ? "POST" : "DELETE",
      ),
    );
  }
  if (a.operation === "set_task_status") {
    if (!d.cloud)
      throw new ServiceError("not_implemented", "Data Center 内容任务尚未实现");
    const path = d.v2(`/tasks/${a.taskId}`);
    const current = await h.json(path);
    if (current.status !== a.expectedStatus)
      throw new ServiceError("conflict", "任务状态已改变，请重新读取");
    await approve(
      { taskId: a.taskId, before: current, after: a.status },
      a.taskId,
    );
    const latest = await h.json(path);
    if (
      latest.status !== current.status ||
      latest.updatedAt !== current.updatedAt
    )
      throw new ServiceError("conflict", "任务已改变，请重新读取");
    return dispatch(() => h.json(path, "PUT", { status: a.status }));
  }
  throw new ServiceError("not_implemented", "此操作尚未实现");
}
export async function writePageCollaboration(
  ctx: Execution,
  a: WriteOperation<
    | "add_labels"
    | "remove_label"
    | "set_watch"
    | "set_property"
    | "delete_property"
    | "add_restriction"
    | "remove_restriction"
  >,
  dispatch: Dispatch,
  p: Page,
): Promise<Json> {
  const d = ctx.adapter;
  const h = d.http;
  const approve = (detail: Json, target = p.id) =>
    ctx.operations.approve(ctx, a.operation, String(target), detail);
  if (a.operation === "add_labels" || a.operation === "remove_label") {
    await approve({
      page: p.title,
      labels: a.operation === "add_labels" ? a.labels : [a.label],
    });
    return dispatch(() =>
      h.json(
        d.v1(
          `/content/${p.id}/label${a.operation === "remove_label" ? `?name=${encodeURIComponent(a.label)}` : ""}`,
        ),
        a.operation === "remove_label" ? "DELETE" : "POST",
        a.operation === "add_labels"
          ? a.labels.map((name) => ({ prefix: "global", name }))
          : undefined,
      ),
    );
  }
  if (a.operation === "set_watch") {
    await approve({ page: p.title, watching: a.watching });
    return dispatch(() =>
      h.json(
        d.v1(`/user/watch/content/${p.id}`),
        a.watching ? "POST" : "DELETE",
      ),
    );
  }
  if (a.operation === "set_property" || a.operation === "delete_property") {
    let current: Json | undefined;
    try {
      current = await ctx.operations.property(ctx, a);
    } catch (e) {
      if (
        !(e instanceof ServiceError) ||
        !["property_missing", "not_found_or_forbidden"].includes(e.code) ||
        a.expectedVersion !== 0
      )
        throw e;
    }
    d.assertVersion(current?.version?.number ?? 0, a.expectedVersion);
    await approve({
      page: p.title,
      key: a.key,
      before: current?.value,
      after: a.operation === "set_property" ? a.value : undefined,
    });
    const endpoint = d.cloud
      ? d.v2(
          `/${d.collection(p.type)}/${p.id}/properties${current ? `/${current.id}` : ""}`,
        )
      : d.v1(
          `/content/${p.id}/property${current ? `/${encodeURIComponent(a.key)}` : ""}`,
        );
    return dispatch(() =>
      h.json(
        endpoint,
        a.operation === "delete_property" ? "DELETE" : current ? "PUT" : "POST",
        a.operation === "delete_property"
          ? undefined
          : {
              key: a.key,
              value: a.value,
              ...(current
                ? { version: { number: a.expectedVersion + 1 } }
                : {}),
            },
      ),
    );
  }
  if (
    a.operation === "add_restriction" ||
    a.operation === "remove_restriction"
  ) {
    const restrictions = await h.json(
      d.v1(
        `/content/${p.id}/restriction/byOperation?expand=restrictions.user,restrictions.group`,
      ),
    );
    await approve({
      page: p.title,
      operation: a.operation,
      restriction: a.restriction,
      subject: a.subject,
      currentRestrictions: restrictions,
      note: "仅修改直接限制；不会改变父页面继承的访问限制。移除最后一个直接限制可能扩大访问范围。",
    });
    const identity =
      a.subject.type === "group"
        ? `group/${encodeURIComponent(a.subject.id)}`
        : `user?${d.cloud ? "accountId" : "userName"}=${encodeURIComponent(a.subject.id)}`;
    return dispatch(() =>
      h.json(
        d.v1(
          `/content/${p.id}/restriction/byOperation/${a.restriction}/${identity}`,
        ),
        a.operation === "add_restriction" ? "PUT" : "DELETE",
      ),
    );
  }
  throw new ServiceError("not_implemented", "此操作尚未实现");
}
