import { assertNever } from "./list-results";
import type { ReadRequest } from "./schema";
import type { Execution } from "./operation-context";
import { ServiceError, type Json } from "./http";
import { availableOperations, describeOperation } from "./discovery";
import { readableStorage, changePreview } from "./content";
import { LocalArtifacts } from "../local-artifacts";
import { exportPage } from "./transfers";
export async function read(ctx: Execution, a: ReadRequest): Promise<Json> {
  const { adapter: d } = ctx;
  const h = d.http;
  const id = "page" in a ? h.pageId(a.page) : "";
  const v1 = (suffix: string) => d.v1(`/content/${id}${suffix}`);
  const v2 = (suffix: string) =>
    d.v2(`/${d.collection("kind" in a ? a.kind : "page")}/${id}${suffix}`);
  switch (a.operation) {
    case "capabilities":
      return {
        deployment: ctx.connection.settings.deployment,
        read: availableOperations(ctx.connection.settings, false).map(
          (s) => s.shape.operation.value,
        ),
        write: availableOperations(ctx.connection.settings, true).map(
          (s) => s.shape.operation.value,
        ),
        discovery:
          "Use describe_operation with name to retrieve one exact input contract before execution.",
        limitations: [
          "Cloud and Data Center API/permission coverage differs; see docs/confluence.md.",
          "Local exports preserve source but do not reproduce native macro rendering.",
          "Only exact storage-fragment edits are supported; section selection uses explicit fragment matching.",
          "Cloud archive is asynchronous; use read_long_task to check completion.",
          "Data Center inline comment writes, archive and copy are not implemented.",
          "Favorites, like mutations, unarchive and tree copy are not implemented yet; these remain tracked in issue #2.",
        ],
      };
    case "describe_operation":
      return describeOperation(ctx.connection.settings, a.name);
    case "current_user":
      return h.json(d.v1("/user/current"));
    case "read_long_task":
      return h.json(d.v1(`/longtask/${encodeURIComponent(a.taskId)}`));
    case "list_tasks": {
      if (!d.cloud)
        throw new ServiceError(
          "not_implemented",
          "Data Center 内容任务尚未实现",
        );
      return ctx.operations.list(
        ctx,
        a,
        d.v2(
          `/tasks?body-format=storage${a.assignedTo ? `&assigned-to=${encodeURIComponent(a.assignedTo)}` : ""}${a.status ? `&status=${a.status}` : ""}`,
        ),
      );
    }
    case "read_task": {
      if (!d.cloud)
        throw new ServiceError(
          "not_implemented",
          "Data Center 内容任务尚未实现",
        );
      return h.json(d.v2(`/tasks/${a.taskId}?body-format=storage`));
    }
    case "list_likes": {
      if (!d.cloud)
        throw new ServiceError(
          "not_implemented",
          "Data Center 点赞读取尚未实现",
        );
      return ctx.operations.list(ctx, a, v2("/likes/users"));
    }
    case "read_space_watch": {
      const space = await d.space(a.space);
      return h.json(d.v1(`/user/watch/space/${encodeURIComponent(space.key)}`));
    }
    case "list_restriction_subjects":
      return ctx.operations.list(
        ctx,
        a,
        v1(`/restriction/byOperation/${a.restriction}/${a.subjectType}`),
      );
    case "search":
      return ctx.operations.list(
        ctx,
        a,
        d.v1(
          `/search?cql=${encodeURIComponent(a.cql)}&expand=content.space,content.version`,
        ),
      );
    case "list_spaces":
      return ctx.operations.list(
        ctx,
        a,
        d.cloud ? d.v2("/spaces") : d.v1("/space?expand=homepage"),
      );
    case "read_space":
      return d.space(a.space);
    case "read_page": {
      const p = await ctx.operations.page(ctx, a, true);
      const readable =
        a.representation === "storage"
          ? { markdown: "", warnings: [] }
          : readableStorage(p.storage, p.url, ctx.connection.settings.url);
      const full =
        a.representation === "storage" ? p.storage : readable.markdown;
      const end = Math.min(full.length, a.offset + a.length);
      return {
        id: p.id,
        title: p.title,
        type: p.type,
        url: p.url,
        version: p.version,
        space: p.space,
        metadata: {
          author: p.raw.authorId ?? p.raw.history?.createdBy,
          modified: p.raw.version,
          ancestors: p.raw.ancestors,
        },
        representation: a.representation,
        content: full.slice(a.offset, end),
        offset: a.offset,
        nextOffset: end < full.length ? end : undefined,
        complete: end >= full.length,
        warnings: readable.warnings,
      };
    }
    case "list_children":
      return ctx.operations.list(
        ctx,
        a,
        d.cloud ? v2("/children") : v1("/child/page"),
      );
    case "list_descendants":
      return ctx.operations.list(
        ctx,
        a,
        d.cloud ? v2("/descendants") : v1("/descendant/page"),
      );
    case "list_ancestors": {
      if (d.cloud) return ctx.operations.list(ctx, a, v2("/ancestors"));
      const raw = await h.json(v1("?expand=ancestors"));
      return { items: raw.ancestors ?? [], complete: true };
    }
    case "list_comments":
      return ctx.operations.list(
        ctx,
        a,
        d.cloud
          ? a.parentCommentId
            ? d.v2(
                `/${a.kindOfComment}-comments/${a.parentCommentId}/children?body-format=storage`,
              )
            : v2(`/${a.kindOfComment}-comments?body-format=storage`)
          : d.v1(
              `/content/${a.parentCommentId ?? id}/child/comment?expand=body.storage,version,ancestors,extensions.inlineProperties&location=${a.kindOfComment}`,
            ),
      );
    case "read_comment":
      return d.comment(a.commentId, a.kindOfComment);
    case "list_versions":
      return ctx.operations.list(
        ctx,
        a,
        d.cloud ? v2("/versions") : v1("/version"),
      );
    case "compare_versions": {
      const from = await d.page(a.page, a.kind, a.from);
      const to = await d.page(a.page, a.kind, a.to);
      return {
        pageId: id,
        url: to.url,
        from: a.from,
        to: a.to,
        diff: changePreview(from.storage, to.storage),
        changed: from.storage !== to.storage,
        representation: "storage",
      };
    }
    case "list_labels":
      return ctx.operations.list(
        ctx,
        a,
        d.cloud ? v2("/labels") : v1("/label"),
      );
    case "list_attachments":
      return ctx.operations.list(
        ctx,
        a,
        d.cloud ? v2("/attachments") : v1("/child/attachment?expand=version"),
      );
    case "read_attachment":
      return d.attachment(a.attachmentId);
    case "download_attachment": {
      const raw = await d.attachment(a.attachmentId);
      const destination = await ctx.operations.prepareDestination(
        a.destination,
      );
      const artifact = await ctx.operations.artifacts.save(
        ctx.sessionId,
        raw.title ?? `attachment-${a.attachmentId}`,
        LocalArtifacts.stream(await d.download(a.attachmentId)),
        destination,
        ctx.signal,
      );
      return {
        attachmentId: a.attachmentId,
        version: raw.version?.number,
        artifacts: [artifact],
      };
    }
    case "export_page":
      return exportPage(ctx, a);
    case "read_restrictions":
      return {
        restrictions: await h.json(
          v1(
            "/restriction/byOperation?expand=restrictions.user,restrictions.group",
          ),
        ),
        note: "直接限制。用户/组列表可能分页；继承限制需沿 list_ancestors 检查。",
      };
    case "read_operations":
      return d.cloud
        ? h.json(v2("/operations"))
        : h.json(v1("?expand=operations"));
    case "list_properties":
      return ctx.operations.list(
        ctx,
        a,
        d.cloud ? v2("/properties") : v1("/property"),
      );
    case "read_property":
      return ctx.operations.property(ctx, a);
    case "list_templates": {
      const space = await d.space(a.space);
      return ctx.operations.list(
        ctx,
        a,
        d.v1(`/template/page?spaceKey=${encodeURIComponent(space.key)}`),
      );
    }
    case "read_template":
      return h.json(d.v1(`/template/${encodeURIComponent(a.templateId)}`));
    case "search_users":
      return ctx.operations.list(
        ctx,
        a,
        d.v1(
          `/search${d.cloud ? "/user" : ""}?cql=${encodeURIComponent(`user.fullname ~ ${JSON.stringify(a.query)}`)}`,
        ),
      );
    case "list_groups":
      return ctx.operations.list(ctx, a, d.v1("/group"));
    case "list_group_members":
      return ctx.operations.list(
        ctx,
        a,
        d.v1(`/group/${encodeURIComponent(a.group)}/member`),
      );
    case "read_watch":
      return h.json(d.v1(`/user/watch/content/${id}`));
    default:
      return assertNever(a);
  }
}
