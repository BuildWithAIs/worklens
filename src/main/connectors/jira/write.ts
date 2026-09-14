import { basename } from "node:path";
import { createHash } from "node:crypto";
import { query, segment } from "./adapter";
import { scope, type Execution } from "./context";
import { encodeDocument } from "./content";
import { deletionFingerprint } from "./read";
import { ReadLimiter, ServiceError, type Json } from "./http";
import type { WriteRequest } from "./schema";
import { uploadBytes } from "./attachments";
import { payload, patch, transition } from "./issue-write";
import { clone } from "./lifecycle-write";
import { completeSprint } from "./planning-write";

export type Dispatch = (
  step: string,
  method: string,
  path: string,
  body?: unknown,
) => Promise<Json>;
export async function write(
  ctx: Execution,
  request: WriteRequest,
  send: Dispatch,
): Promise<Json> {
  const a = request as Json;
  const d = ctx.adapter;
  const api = d.api;
  const issue = () => d.issuePath(a.issue);
  const sendOne = (method: string, path: string, body?: unknown) =>
    send("mutation", method, path, body);
  switch (request.operation) {
    case "create_issue": {
      const fields = {
        ...payload(a, d.cloud),
        project: /^\d+$/.test(a.project)
          ? { id: a.project }
          : { key: a.project },
        issuetype: { id: a.issueType },
      };
      const meta = await d.metadata(a.project, a.issueType);
      // Context is supplied by the operation, rather than requiring duplicate fields.
      await d.validateFields(
        fields,
        {
          ...meta,
          project: meta.project ?? {},
          issuetype: meta.issuetype ?? {},
        },
        true,
      );
      return sendOne("POST", api + "/issue", { fields });
    }
    case "update_issue":
      return patch(ctx, a, send);
    case "transition_issue":
      return transition(ctx, a, send);
    case "assign_issue": {
      await d.checkIssue(a.issue, a.expectedUpdated);
      if (a.user !== null) {
        const candidates = await d.all(
          query(api + "/user/assignable/search", {
            issueKey: d.http.issueId(a.issue),
            [d.cloud ? "accountId" : "username"]: a.user,
          }),
        );
        if (
          !candidates.some((u) => (d.cloud ? u.accountId : u.name) === a.user)
        )
          throw new ServiceError(
            "invalid_user",
            "用户不是当前工单的可指派用户；使用 assignable_users 查找准确 ID",
          );
      }
      return sendOne("PUT", issue() + "/assignee", {
        [d.cloud ? "accountId" : "name"]: a.user,
      });
    }
    case "set_parent":
      return patch(
        ctx,
        {
          ...a,
          fields: {
            [a.field]:
              a.parent === null
                ? null
                : a.field === "parent"
                  ? { key: d.http.issueId(a.parent) }
                  : d.http.issueId(a.parent),
          },
        },
        send,
      );
    case "delete_issue": {
      const current = await d.issue(a.issue);
      const fingerprint = await ctx.cursors.resolve(
        scope(ctx, { operation: "delete_issue", issue: current.id }),
        a.preview,
      );
      if (fingerprint !== deletionFingerprint(current))
        throw new ServiceError(
          "conflict",
          "删除范围已变化；重新 preview_delete",
        );
      if (current.fields.subtasks?.length && !a.deleteSubtasks)
        throw new ServiceError(
          "invalid_request",
          "工单含子任务，请明确是否包含子任务",
        );
      return sendOne(
        "DELETE",
        query(issue(), { deleteSubtasks: a.deleteSubtasks }),
      );
    }
    case "add_comment":
      return sendOne("POST", issue() + "/comment", {
        body: encodeDocument(a.body, d.cloud),
        ...(a.visibility ? { visibility: a.visibility } : {}),
      });
    case "edit_comment":
    case "delete_comment": {
      const path = issue() + "/comment/" + segment(a.comment);
      const current = await d.get(path);
      if (current.updated !== a.expectedUpdated)
        throw new ServiceError("conflict", "评论已修改，请重新读取");
      return sendOne(
        a.operation === "edit_comment" ? "PUT" : "DELETE",
        path,
        a.operation === "edit_comment"
          ? {
              body: encodeDocument(a.body, d.cloud),
              ...(a.visibility !== undefined
                ? { visibility: a.visibility }
                : current.visibility
                  ? { visibility: current.visibility }
                  : {}),
            }
          : undefined,
      );
    }
    case "link_issues": {
      const types = await d.get(api + "/issueLinkType");
      const type = types.issueLinkTypes?.find(
        (t: Json) => String(t.id) === a.type,
      );
      if (!type)
        throw new ServiceError(
          "invalid_request",
          "未知关联类型，请使用 list_link_types 获取 ID",
        );
      const first = d.http.issueId(a.issue);
      const second = d.http.issueId(a.other);
      return sendOne("POST", api + "/issueLink", {
        type: { id: a.type },
        inwardIssue: { key: a.direction === "outward" ? first : second },
        outwardIssue: { key: a.direction === "outward" ? second : first },
      });
    }
    case "unlink_issues": {
      const current = await d.issue(a.issue, ["issuelinks"]);
      if (
        !current.fields.issuelinks?.some((l: Json) => String(l.id) === a.link)
      )
        throw new ServiceError("invalid_target", "关联不属于该工单");
      return sendOne("DELETE", api + "/issueLink/" + segment(a.link));
    }
    case "set_remote_link": {
      if (!/^https?:/.test(a.url))
        throw new ServiceError("invalid_request", "远程链接需要 HTTP(S) URL");
      return sendOne(
        a.link ? "PUT" : "POST",
        issue() + "/remotelink" + (a.link ? "/" + segment(a.link) : ""),
        {
          object: { url: a.url, title: a.title },
          relationship: a.relationship,
        },
      );
    }
    case "delete_remote_link":
      return sendOne("DELETE", issue() + "/remotelink/" + segment(a.link));
    case "set_watch": {
      const me =
        a.user ??
        (await d.get(api + "/myself"))[d.cloud ? "accountId" : "name"];
      return sendOne(
        a.watching ? "POST" : "DELETE",
        a.watching
          ? issue() + "/watchers"
          : query(issue() + "/watchers", {
              [d.cloud ? "accountId" : "username"]: me,
            }),
        a.watching ? me : undefined,
      );
    }
    case "set_vote":
      return sendOne(a.voting ? "POST" : "DELETE", issue() + "/votes");
    case "upload_attachment": {
      const bytes = await uploadBytes(ctx, a.filePath);
      const settings = await d.get(api + "/attachment/meta");
      if (
        !settings.enabled ||
        (settings.uploadLimit !== undefined &&
          bytes.length > settings.uploadLimit)
      )
        throw new ServiceError(
          "invalid_file",
          "本站未启用附件，或文件超过本站上传上限",
        );
      const form = new FormData();
      form.append(
        "file",
        new Blob([new Uint8Array(bytes)]),
        basename(a.filePath),
      );
      return send(
        "upload:" + createHash("sha256").update(bytes).digest("hex"),
        "POST",
        issue() + "/attachments",
        form,
      );
    }
    case "delete_attachment": {
      const data = await d.issue(a.issue, ["attachment"]);
      if (
        !data.fields.attachment?.some(
          (f: Json) => String(f.id) === a.attachment,
        )
      )
        throw new ServiceError("invalid_target", "附件不属于该工单");
      return sendOne("DELETE", api + "/attachment/" + segment(a.attachment));
    }
    case "add_worklog":
    case "edit_worklog":
    case "delete_worklog": {
      const path =
        issue() + "/worklog" + (a.worklog ? "/" + segment(a.worklog) : "");
      let previous: Json | undefined;
      if (a.worklog) {
        previous = await d.get(path);
        if (previous.updated !== a.expectedUpdated)
          throw new ServiceError("conflict", "工时记录已修改，请重新读取");
      }
      const params = {
        adjustEstimate: a.estimate.mode,
        newEstimate:
          a.estimate.mode === "new" ? a.estimate.remaining : undefined,
      };
      const body =
        a.operation === "delete_worklog"
          ? undefined
          : {
              started: a.started,
              timeSpentSeconds: a.timeSpentSeconds,
              ...(a.comment
                ? { comment: encodeDocument(a.comment, d.cloud) }
                : previous?.comment
                  ? { comment: previous.comment }
                  : {}),
              ...(a.visibility
                ? { visibility: a.visibility }
                : previous?.visibility
                  ? { visibility: previous.visibility }
                  : {}),
            };
      return sendOne(
        a.operation === "add_worklog"
          ? "POST"
          : a.operation === "edit_worklog"
            ? "PUT"
            : "DELETE",
        query(path, params),
        body,
      );
    }
    case "create_filter":
      return sendOne("POST", api + "/filter", {
        name: a.name,
        jql: a.jql,
        description: a.description,
        favourite: a.favourite,
      });
    case "update_filter":
    case "delete_filter": {
      const path = api + "/filter/" + segment(a.filter);
      const current = await d.get(path);
      const me = await d.get(api + "/myself");
      if (
        !current.owner ||
        (d.cloud
          ? current.owner.accountId !== me.accountId
          : current.owner.name !== me.name)
      )
        throw new ServiceError("permission", "只能修改自己的筛选器");
      return sendOne(
        a.operation === "delete_filter" ? "DELETE" : "PUT",
        path,
        a.operation === "delete_filter"
          ? undefined
          : { name: a.name, jql: a.jql, description: a.description },
      );
    }
    case "set_filter_favourite":
      return sendOne(
        a.favourite ? "PUT" : "DELETE",
        (d.cloud ? api + "/filter/" : "/rest/api/1.0/filters/") +
          segment(a.filter) +
          "/favourite",
      );
    case "move_to_sprint":
      return sendOne(
        "POST",
        d.agile + "/sprint/" + segment(a.sprint) + "/issue",
        { issues: a.issues.map((i: string) => d.http.issueId(i)) },
      );
    case "move_to_backlog":
      return sendOne("POST", d.agile + "/backlog/issue", {
        issues: a.issues.map((i: string) => d.http.issueId(i)),
      });
    case "rank_issues": {
      if (Boolean(a.before) === Boolean(a.after))
        throw new ServiceError(
          "invalid_request",
          "必须提供 before 或 after 之一",
        );
      const config = await d.get(
        d.agile + "/board/" + segment(a.board) + "/configuration",
      );
      if (!config.ranking?.rankCustomFieldId)
        throw new ServiceError("unavailable", "该看板没有可用排序字段");
      return sendOne("PUT", d.agile + "/issue/rank", {
        issues: a.issues.map((i: string) => d.http.issueId(i)),
        rankCustomFieldId: config.ranking.rankCustomFieldId,
        rankBeforeIssue: a.before ? d.http.issueId(a.before) : undefined,
        rankAfterIssue: a.after ? d.http.issueId(a.after) : undefined,
      });
    }
    case "set_estimate":
      return sendOne(
        "PUT",
        query(
          d.agile +
            "/issue/" +
            segment(d.http.issueId(a.issue)) +
            "/estimation",
          { boardId: a.board },
        ),
        { value: String(a.value) },
      );
    case "create_sprint":
      return sendOne("POST", d.agile + "/sprint", {
        originBoardId: Number(a.board),
        name: a.name,
        goal: a.goal,
        startDate: a.startDate,
        endDate: a.endDate,
      });
    case "update_sprint":
      return sendOne("POST", d.agile + "/sprint/" + segment(a.sprint), {
        name: a.name,
        goal: a.goal,
        startDate: a.startDate,
        endDate: a.endDate,
      });
    case "start_sprint": {
      if (Date.parse(a.endDate) <= Date.parse(a.startDate))
        throw new ServiceError("invalid_request", "结束时间必须晚于开始时间");
      const path = d.agile + "/sprint/" + segment(a.sprint);
      const current = await d.get(path);
      if (current.state !== "future")
        throw new ServiceError("conflict", "只能开始 future Sprint");
      return sendOne("POST", path, {
        state: "active",
        startDate: a.startDate,
        endDate: a.endDate,
      });
    }
    case "create_version": {
      const project = await d.get(api + "/project/" + segment(a.project));
      const projectId = Number(project.id);
      if (!Number.isSafeInteger(projectId) || projectId <= 0)
        throw new ServiceError("invalid_response", "项目响应缺少有效数字 ID");
      return sendOne("POST", api + "/version", {
        projectId,
        name: a.name,
        description: a.description,
        startDate: a.startDate,
        releaseDate: a.releaseDate,
      });
    }
    case "update_version":
      return sendOne("PUT", api + "/version/" + segment(a.version), {
        name: a.name,
        description: a.description,
        startDate: a.startDate,
        releaseDate: a.releaseDate,
        released: a.released,
        archived: a.archived,
      });
    case "release_version":
      return sendOne("PUT", api + "/version/" + segment(a.version), {
        released: true,
        releaseDate: a.releaseDate,
      });
    case "batch": {
      const results: Json[] = [];
      const expected = new Map<string, string>();
      if (a.preview) {
        const preview = JSON.parse(
          await ctx.cursors.resolve(
            scope(ctx, { operation: "batch", items: a.items }),
            a.preview,
          ),
        );
        for (const item of preview) expected.set(item.id, item.expectedUpdated);
      }
      const keys = a.items.map((i: Json) => d.http.issueId(i.issue));
      if (new Set(keys).size !== keys.length)
        throw new ServiceError(
          "invalid_request",
          "同一批次不能重复包含同一工单",
        );
      const identities = new Set<string>();
      const preflightErrors = new Map<number, unknown>();
      const preflight = new ReadLimiter(4);
      // Fetch only identities/timestamps; all preflight checks finish before any write.
      const checked = await Promise.allSettled(
        a.items.map((item: Json, n: number) =>
          preflight.run(ctx.signal, async () => {
            let current: Json;
            try {
              current = await d.issue(item.issue, ["updated"]);
            } catch (error) {
              preflightErrors.set(n, error);
              return;
            }
            if (
              expected.has(current.id) &&
              current.fields.updated !== expected.get(current.id)
            )
              throw new ServiceError("conflict", "工单已变更，请重新准备批次");
            if (identities.has(current.id))
              throw new ServiceError(
                "invalid_request",
                "批次中的 key 和 ID 指向重复工单",
              );
            identities.add(current.id);
          }),
        ),
      );
      for (const result of checked)
        if (result.status === "rejected") throw result.reason;
      if (a.preview && preflightErrors.size)
        throw preflightErrors.values().next().value;
      for (const [n, item] of a.items.entries()) {
        if (ctx.signal.aborted) {
          results.push({ issue: item.issue, status: "not_executed" });
          continue;
        }
        try {
          if (preflightErrors.has(n)) throw preflightErrors.get(n);
          const result = await (item.action === "update" ? patch : transition)(
            ctx,
            item,
            (step, method, path, body) =>
              send(`item:${n}:${step}`, method, path, body),
          );
          results.push({ issue: item.issue, status: "success", result });
        } catch (error) {
          results.push({
            issue: item.issue,
            status: error instanceof ServiceError ? error.code : "failed",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return {
        status: results.every((r) => r.status === "success")
          ? "success"
          : "partial",
        results,
        retry:
          "Only retry failed/not_executed items. Reconcile unknown items by reading first; batches are not transactions.",
      };
    }
    case "clone_issue":
      return clone(ctx, a, send);
    case "complete_sprint":
      return completeSprint(ctx, a, send);
  }
}
