import { z } from "zod";
import { define, repo, id, name, text } from "./catalog";
import { type Context, resource, node, graphWrite, graphPage } from "./context";
import { ServiceError, type Json } from "./http";

for (const operation of ["pin_issue", "unpin_issue", "delete_issue"])
  define(
    operation,
    `${operation.replaceAll("_", " ")} on the specified repository`,
    { repo, issue_number: id },
    { write: true },
  );
define(
  "transfer_issue",
  "Transfer an issue to an explicitly named repository on this site",
  { repo, issue_number: id, destinationRepo: repo },
  { write: true },
);
define(
  "discussion_categories",
  "Discover discussion categories and category capabilities",
  { repo, after: text.optional() },
);
define("list_discussions", "List repository discussions", {
  repo,
  after: text.optional(),
});
define("read_discussion", "Read discussion and accepted answer", {
  repo,
  number: id,
});
define(
  "search_discussions",
  "Search discussions using supported native qualifiers",
  { query: text, after: text.optional() },
);
define(
  "discussion_comments",
  "Read top-level discussion comments; replies paginate separately",
  { repo, number: id, after: text.optional() },
);
define("discussion_replies", "Read replies to a discussion comment", {
  commentId: name,
  after: text.optional(),
});
define(
  "create_discussion",
  "Create a discussion in a discovered category",
  { repo, categoryId: name, title: name, body: text },
  { write: true },
);
define(
  "update_discussion",
  "Edit discussion title/body/category",
  {
    repo,
    number: id,
    title: name.optional(),
    body: text.optional(),
    categoryId: name.optional(),
  },
  { write: true },
);
define(
  "delete_discussion",
  "Delete a discussion and its comments",
  { repo, number: id },
  { write: true },
);
define(
  "add_discussion_comment",
  "Add a discussion comment or reply",
  { repo, number: id, body: text, replyToId: name.optional() },
  { write: true },
);
define(
  "edit_discussion_comment",
  "Edit a discussion comment",
  { repo, number: id, commentId: name, body: text },
  { write: true },
);
define(
  "delete_discussion_comment",
  "Delete a discussion comment",
  { repo, number: id, commentId: name },
  { write: true },
);
for (const operation of ["mark_discussion_answer", "unmark_discussion_answer"])
  define(
    operation,
    "Mark or unmark an answer where the discussion category and permissions allow",
    { repo, number: id, commentId: name },
    { write: true },
  );
const reaction = z.enum([
  "THUMBS_UP",
  "THUMBS_DOWN",
  "LAUGH",
  "HOORAY",
  "CONFUSED",
  "HEART",
  "ROCKET",
  "EYES",
]);
for (const operation of [
  "add_discussion_reaction",
  "remove_discussion_reaction",
])
  define(
    operation,
    "React to a discussion or its comment",
    { repo, number: id, commentId: name.optional(), content: reaction },
    { write: true },
  );
async function discussion(ctx: Context, request: Json) {
  const repository = await resource(ctx, request, "repository");
  const result = await ctx.http.graphql(
    "query($id:ID!,$number:Int!){node(id:$id){... on Repository{discussion(number:$number){id number title body url category{id name isAnswerable} answer{id body url} locked}}}}",
    { id: repository.node_id, number: request.number },
  );
  if (!result.node?.discussion)
    throw new ServiceError("not_found_or_forbidden", "无法访问该 Discussion");
  return { repository, discussion: result.node.discussion };
}
export async function collaborationOperation(
  ctx: Context,
  request: Json,
): Promise<Json | undefined> {
  if (
    ["pin_issue", "unpin_issue", "delete_issue", "transfer_issue"].includes(
      request.operation,
    )
  ) {
    const issue = await resource(ctx, request, "issue");
    if (issue.pull_request)
      throw new ServiceError("invalid_target", "此操作仅适用于 Issue");
    if (request.operation === "transfer_issue") {
      const target = await resource(
        ctx,
        { repo: request.destinationRepo },
        "repository",
      );
      return graphWrite(
        ctx,
        "transferIssue",
        "TransferIssueInput",
        { issueId: issue.node_id, repositoryId: target.node_id },
        "issue{id number url}",
      );
    }
    const mapping: Record<string, [string, string, string]> = {
      pin_issue: ["pinIssue", "PinIssueInput", "issue{id url}"],
      unpin_issue: ["unpinIssue", "UnpinIssueInput", "issue{id url}"],
      delete_issue: ["deleteIssue", "DeleteIssueInput", "clientMutationId"],
    };
    const [field, type, selection] = mapping[request.operation];
    return graphWrite(ctx, field, type, { issueId: issue.node_id }, selection);
  }
  if (request.operation === "search_discussions") {
    const data = await ctx.http.graphql(
      "query($query:String!,$after:String){search(query:$query,type:DISCUSSION,first:50,after:$after){discussionCount nodes{... on Discussion{id number title url updatedAt repository{nameWithOwner}}}pageInfo{hasNextPage endCursor}}}",
      { query: request.query, after: request.after },
    );
    const result = await graphPage(ctx, request, data.search);
    if (data.search.discussionCount > 1000)
      return {
        ...result,
        complete: false,
        searchCapped: true,
        totalCount: data.search.discussionCount,
      };
    return result;
  }
  if (
    ["list_discussions", "discussion_categories"].includes(request.operation)
  ) {
    const repository = await resource(ctx, request, "repository");
    const categories = request.operation === "discussion_categories";
    const field = categories ? "discussionCategories" : "discussions";
    const selection = categories
      ? "id name description isAnswerable slug"
      : "id number title url updatedAt category{id name}";
    const data = await ctx.http.graphql(
      `query($id:ID!,$after:String){node(id:$id){... on Repository{${field}(first:50,after:$after){nodes{${selection}}pageInfo{hasNextPage endCursor}}}}}`,
      { id: repository.node_id, after: request.after },
    );
    return graphPage(ctx, request, data.node?.[field]);
  }
  if (request.operation === "discussion_replies") {
    const data = await ctx.http.graphql(
      "query($id:ID!,$after:String){node(id:$id){... on DiscussionComment{replies(first:50,after:$after){nodes{id body url author{login} isAnswer}pageInfo{hasNextPage endCursor}}}}}",
      { id: request.commentId, after: request.after },
    );
    return graphPage(ctx, request, data.node?.replies);
  }
  if (request.operation === "create_discussion") {
    const repository = await resource(ctx, request, "repository");
    const category = await node(
      ctx,
      request.categoryId,
      "DiscussionCategory",
      "repository{id}",
    );
    if (category.repository.id !== repository.node_id)
      throw new ServiceError("invalid_target", "分类不属于当前仓库");
    return graphWrite(
      ctx,
      "createDiscussion",
      "CreateDiscussionInput",
      {
        repositoryId: repository.node_id,
        categoryId: request.categoryId,
        title: request.title,
        body: request.body,
      },
      "discussion{id number url}",
    );
  }
  if (!request.operation.includes("discussion")) return;
  const target = await discussion(ctx, request);
  if (request.operation === "read_discussion") return target.discussion;
  if (request.operation === "discussion_comments") {
    const data = await ctx.http.graphql(
      "query($id:ID!,$after:String){node(id:$id){... on Discussion{comments(first:50,after:$after){nodes{id body url isAnswer author{login} replies(first:1){totalCount pageInfo{hasNextPage endCursor}nodes{id body}}}pageInfo{hasNextPage endCursor}}}}}",
      { id: target.discussion.id, after: request.after },
    );
    return graphPage(ctx, request, data.node?.comments);
  }
  if (request.commentId || request.replyToId) {
    const comment = await node(
      ctx,
      request.commentId ?? request.replyToId,
      "DiscussionComment",
      "discussion{id}",
    );
    if (comment.discussion.id !== target.discussion.id)
      throw new ServiceError("invalid_target", "评论不属于指定 Discussion");
  }
  if (request.operation === "update_discussion") {
    if (request.categoryId) {
      const category = await node(
        ctx,
        request.categoryId,
        "DiscussionCategory",
        "repository{id}",
      );
      if (category.repository.id !== target.repository.node_id)
        throw new ServiceError("invalid_target", "分类不属于当前仓库");
    }
    return graphWrite(
      ctx,
      "updateDiscussion",
      "UpdateDiscussionInput",
      {
        discussionId: target.discussion.id,
        title: request.title,
        body: request.body,
        categoryId: request.categoryId,
      },
      "discussion{id url}",
    );
  }
  if (request.operation === "delete_discussion")
    return graphWrite(
      ctx,
      "deleteDiscussion",
      "DeleteDiscussionInput",
      { id: target.discussion.id },
      "clientMutationId",
    );
  if (request.operation === "add_discussion_comment")
    return graphWrite(
      ctx,
      "addDiscussionComment",
      "AddDiscussionCommentInput",
      {
        discussionId: target.discussion.id,
        body: request.body,
        replyToId: request.replyToId,
      },
      "comment{id url}",
    );
  if (request.operation === "edit_discussion_comment")
    return graphWrite(
      ctx,
      "updateDiscussionComment",
      "UpdateDiscussionCommentInput",
      { commentId: request.commentId, body: request.body },
      "comment{id url}",
    );
  if (request.operation === "delete_discussion_comment")
    return graphWrite(
      ctx,
      "deleteDiscussionComment",
      "DeleteDiscussionCommentInput",
      { id: request.commentId },
      "clientMutationId",
    );
  if (
    ["mark_discussion_answer", "unmark_discussion_answer"].includes(
      request.operation,
    )
  ) {
    if (!target.discussion.category.isAnswerable)
      throw new ServiceError("unsupported_capability", "此分类不支持标记答案");
    const mark = request.operation === "mark_discussion_answer";
    return graphWrite(
      ctx,
      mark
        ? "markDiscussionCommentAsAnswer"
        : "unmarkDiscussionCommentAsAnswer",
      mark
        ? "MarkDiscussionCommentAsAnswerInput"
        : "UnmarkDiscussionCommentAsAnswerInput",
      { id: request.commentId },
      "clientMutationId",
    );
  }
  if (
    ["add_discussion_reaction", "remove_discussion_reaction"].includes(
      request.operation,
    )
  ) {
    const add = request.operation === "add_discussion_reaction";
    return graphWrite(
      ctx,
      add ? "addReaction" : "removeReaction",
      add ? "AddReactionInput" : "RemoveReactionInput",
      {
        subjectId: request.commentId ?? target.discussion.id,
        content: request.content,
      },
      "clientMutationId",
    );
  }
}
