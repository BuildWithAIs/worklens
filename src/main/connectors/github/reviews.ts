import { z } from "zod";
import { define, repo, id, name, sha, text } from "./catalog";
import {
  type Context,
  params,
  targetParams,
  resource,
  node,
  graphWrite,
  graphPage,
  restWrite,
} from "./context";
import { ServiceError, type Json } from "./http";

const pr = { repo, pull_number: id };
define(
  "review_threads",
  "Read PR review threads; comments have separate pagination",
  { ...pr, after: text.optional() },
);
define("thread_comments", "Read all comments of a review thread", {
  threadId: name,
  after: text.optional(),
});
for (const [operation, description] of [
  ["resolve_thread", "Resolve a review thread"],
  ["unresolve_thread", "Reopen a resolved review thread"],
])
  define(operation, description, { ...pr, threadId: name }, { write: true });
for (const [operation, description] of [
  ["mark_pr_ready", "Mark draft PR ready for review"],
  ["convert_pr_to_draft", "Convert PR to draft"],
  ["disable_auto_merge", "Disable PR auto-merge"],
])
  define(operation, description, pr, { write: true });
define(
  "enable_auto_merge",
  "Enable auto-merge at expected head; server enforces repository rules",
  {
    ...pr,
    expectedHeadSha: sha,
    mergeMethod: z.enum(["MERGE", "SQUASH", "REBASE"]),
  },
  { write: true },
);
define(
  "enqueue_pr",
  "Enqueue PR at expected head in the repository merge queue without bypassing rules",
  { ...pr, expectedHeadSha: sha },
  { write: true },
);
define("dequeue_pr", "Remove PR from the merge queue", pr, { write: true });

export async function expectedPr(ctx: Context, request: Json) {
  const value = await resource(ctx, request, "pr");
  if (value.head?.sha !== request.expectedHeadSha)
    throw new ServiceError("conflict", "PR head 已变更，请重新读取代码和差异", {
      actualHeadSha: value.head?.sha,
    });
  if (value.state !== "open")
    throw new ServiceError("conflict", "PR 已关闭或合并");
  return value;
}
// Build valid anchors from actual patch hunks; omitted/truncated patches cannot authorize guessed lines.
export function diffLines(patch: string) {
  const left = new Set<number>();
  const right = new Set<number>();
  let old = 0;
  let next = 0;
  let hunk = false;
  for (const line of patch.split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      old = Number(header[1]);
      next = Number(header[2]);
      hunk = true;
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith("+")) right.add(next++);
    else if (line.startsWith("-")) left.add(old++);
    else if (line.startsWith(" ")) {
      left.add(old++);
      right.add(next++);
    }
  }
  return { LEFT: left, RIGHT: right };
}
async function validateComments(ctx: Context, request: Json, comments: Json[]) {
  if (!comments.length) return;
  const files: Json[] = [];
  for (let page = 1; page <= 30; page++) {
    const response = await ctx.http.rest(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
      { ...targetParams(ctx, request, "pull_number"), per_page: 100, page },
    );
    files.push(...response.data);
    if (response.data.length < 100) break;
  }
  for (const comment of comments) {
    const file = files.find((f) => f.filename === comment.path);
    if (!file?.patch)
      throw new ServiceError(
        "invalid_anchor",
        "该文件没有可用 diff patch，无法验证行号",
      );
    const lines = diffLines(file.patch);
    const side = comment.side as "LEFT" | "RIGHT";
    if (!lines[side].has(comment.line))
      throw new ServiceError("invalid_anchor", "评论行不在当前 diff 中");
    if (comment.start_line !== undefined) {
      if (
        comment.start_side !== side ||
        comment.start_line > comment.line ||
        comment.line - comment.start_line > 10000
      )
        throw new ServiceError("invalid_anchor", "多行评论范围无效");
      for (let n = comment.start_line; n <= comment.line; n++)
        if (!lines[side].has(n))
          throw new ServiceError(
            "invalid_anchor",
            "多行评论跨越未显示的 diff 行",
          );
    } else if (comment.start_side !== undefined)
      throw new ServiceError("invalid_anchor", "start_side 需要 start_line");
  }
  await expectedPr(ctx, request);
}
export async function reviewOperation(
  ctx: Context,
  request: Json,
): Promise<Json | undefined> {
  const p = params(ctx, request);
  switch (request.operation) {
    case "review_threads": {
      const pr = await resource(ctx, request, "pr");
      const value = await ctx.http.graphql(
        "query($id:ID!,$after:String){node(id:$id){... on PullRequest{reviewThreads(first:50,after:$after){nodes{id isResolved isOutdated path line startLine diffSide comments(first:1){nodes{id databaseId body url} pageInfo{hasNextPage endCursor}}}pageInfo{hasNextPage endCursor}}}}}",
        { id: pr.node_id, after: request.after },
      );
      return graphPage(ctx, request, value.node?.reviewThreads, {
        url: pr.html_url,
      });
    }
    case "thread_comments": {
      const value = await ctx.http.graphql(
        "query($id:ID!,$after:String){node(id:$id){... on PullRequestReviewThread{comments(first:50,after:$after){nodes{id databaseId body url createdAt author{login}}pageInfo{hasNextPage endCursor}}}}}",
        { id: request.threadId, after: request.after },
      );
      return graphPage(ctx, request, value.node?.comments);
    }
    case "resolve_thread":
    case "unresolve_thread": {
      const pr = await resource(ctx, request, "pr");
      const thread = await node(
        ctx,
        request.threadId,
        "PullRequestReviewThread",
        "pullRequest{id}",
      );
      if (thread.pullRequest.id !== pr.node_id)
        throw new ServiceError("invalid_target", "评审线程不属于指定 PR");
      const resolve = request.operation === "resolve_thread";
      return graphWrite(
        ctx,
        resolve ? "resolveReviewThread" : "unresolveReviewThread",
        resolve ? "ResolveReviewThreadInput" : "UnresolveReviewThreadInput",
        { threadId: request.threadId },
        "thread{id isResolved}",
      );
    }
    case "create_review":
    case "add_review_comment": {
      await expectedPr(ctx, request);
      const comments =
        request.operation === "create_review"
          ? (request.comments ?? [])
          : [request];
      await validateComments(ctx, request, comments);
      const { expectedHeadSha, ...args } = p;
      return restWrite(
        ctx,
        request.operation,
        request.operation === "create_review"
          ? "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews"
          : "POST /repos/{owner}/{repo}/pulls/{pull_number}/comments",
        { ...args, commit_id: expectedHeadSha },
      );
    }
    case "submit_review": {
      await expectedPr(ctx, request);
      const review = (
        await ctx.http.rest(
          "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}",
          targetParams(ctx, request, "pull_number", "review_id"),
        )
      ).data;
      if (
        review.commit_id !== request.expectedHeadSha ||
        review.state !== "PENDING"
      )
        throw new ServiceError("conflict", "评审不是当前提交上的待提交草稿");
      const { expectedHeadSha: _sha, ...args } = p;
      return restWrite(
        ctx,
        "submit_review",
        "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/events",
        args,
      );
    }
    case "merge_pr": {
      const pr = await expectedPr(ctx, request);
      if (
        pr.draft ||
        pr.mergeable !== true ||
        ["blocked", "dirty", "behind", "unknown"].includes(pr.mergeable_state)
      )
        throw new ServiceError(
          "conflict",
          "PR 当前不能合并，请检查草稿状态、冲突、检查和分支规则",
          { mergeable: pr.mergeable, mergeableState: pr.mergeable_state },
        );
      const repo = await resource(ctx, request, "repository");
      if (repo[`allow_${request.merge_method}_merge`] === false)
        throw new ServiceError("permission", "仓库不允许此合并方式");
      const { expectedHeadSha, ...args } = p;
      const result = await restWrite(
        ctx,
        "merge_pr",
        "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge",
        { ...args, sha: expectedHeadSha },
      );
      if (!result.merged)
        throw new ServiceError(
          "conflict",
          result.message ?? "GitHub 未合并 PR",
          result,
        );
      return result;
    }
    case "mark_pr_ready":
    case "convert_pr_to_draft":
    case "disable_auto_merge":
    case "enable_auto_merge":
    case "enqueue_pr":
    case "dequeue_pr": {
      const value = request.expectedHeadSha
        ? await expectedPr(ctx, request)
        : await resource(ctx, request, "pr");
      const mapping: Record<string, [string, string, string]> = {
        mark_pr_ready: [
          "markPullRequestReadyForReview",
          "MarkPullRequestReadyForReviewInput",
          "pullRequest{id url isDraft}",
        ],
        convert_pr_to_draft: [
          "convertPullRequestToDraft",
          "ConvertPullRequestToDraftInput",
          "pullRequest{id url isDraft}",
        ],
        disable_auto_merge: [
          "disablePullRequestAutoMerge",
          "DisablePullRequestAutoMergeInput",
          "pullRequest{id url}",
        ],
        enable_auto_merge: [
          "enablePullRequestAutoMerge",
          "EnablePullRequestAutoMergeInput",
          "pullRequest{id url autoMergeRequest{enabledAt}}",
        ],
        enqueue_pr: [
          "enqueuePullRequest",
          "EnqueuePullRequestInput",
          "mergeQueueEntry{id}",
        ],
        dequeue_pr: [
          "dequeuePullRequest",
          "DequeuePullRequestInput",
          "clientMutationId",
        ],
      };
      const [field, type, selection] = mapping[request.operation];
      const result = await graphWrite(
        ctx,
        field,
        type,
        {
          ...(request.operation === "dequeue_pr"
            ? { id: value.node_id }
            : { pullRequestId: value.node_id }),
          ...(request.mergeMethod ? { mergeMethod: request.mergeMethod } : {}),
          ...(["enqueue_pr", "enable_auto_merge"].includes(request.operation)
            ? { expectedHeadOid: request.expectedHeadSha }
            : {}),
        },
        selection,
      );
      return {
        ...result,
        status: ["enable_auto_merge", "enqueue_pr"].includes(request.operation)
          ? "accepted"
          : "success",
      };
    }
  }
}
