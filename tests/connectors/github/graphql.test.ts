import { expect, it } from "vitest";
import { setup } from "./setup";
import { HEAD } from "./fixture";

it("validates the complete collaboration and project workflows against the pinned official GraphQL schema", async () => {
  const s = await setup();
  const pr = { repo: "o/r", pull_number: 1 };
  const discussion = { repo: "o/r", number: 1 };
  const project = { owner: "o", ownerType: "organization", number: 1 };
  const item = { ...project, itemId: "ITEM" };
  const reads = [
    { operation: "review_threads", ...pr },
    { operation: "review_threads", ...pr, after: "cursor" },
    { operation: "thread_comments", threadId: "THREAD" },
    { operation: "discussion_categories", repo: "o/r" },
    { operation: "list_discussions", repo: "o/r" },
    { operation: "read_discussion", ...discussion },
    { operation: "discussion_comments", ...discussion },
    { operation: "discussion_replies", commentId: "DC" },
    { operation: "search_discussions", query: "repo:o/r help" },
    { operation: "list_projects", owner: "o", ownerType: "organization" },
    { operation: "list_projects", owner: "u", ownerType: "user" },
    { operation: "read_project", ...project },
    { operation: "project_fields", ...project },
    { operation: "project_views", ...project },
    { operation: "project_items", ...project },
    { operation: "project_item_fields", ...item },
  ];
  const writes = [
    ...["pin_issue", "unpin_issue", "delete_issue"].map((operation) => ({
      operation,
      repo: "o/r",
      issue_number: 1,
    })),
    {
      operation: "transfer_issue",
      repo: "o/r",
      issue_number: 1,
      destinationRepo: "o/other",
    },
    ...["resolve_thread", "unresolve_thread"].map((operation) => ({
      operation,
      ...pr,
      threadId: "THREAD",
    })),
    ...[
      "mark_pr_ready",
      "convert_pr_to_draft",
      "disable_auto_merge",
      "dequeue_pr",
    ].map((operation) => ({ operation, ...pr })),
    {
      operation: "enable_auto_merge",
      ...pr,
      expectedHeadSha: HEAD,
      mergeMethod: "SQUASH",
    },
    { operation: "enqueue_pr", ...pr, expectedHeadSha: HEAD },
    {
      operation: "create_discussion",
      repo: "o/r",
      categoryId: "CATEGORY",
      title: "Help",
      body: "Question",
    },
    {
      operation: "update_discussion",
      ...discussion,
      title: "Updated",
      categoryId: "CATEGORY",
    },
    { operation: "delete_discussion", ...discussion },
    {
      operation: "add_discussion_comment",
      ...discussion,
      body: "Reply",
      replyToId: "DC",
    },
    {
      operation: "edit_discussion_comment",
      ...discussion,
      commentId: "DC",
      body: "Edit",
    },
    ...[
      "delete_discussion_comment",
      "mark_discussion_answer",
      "unmark_discussion_answer",
    ].map((operation) => ({ operation, ...discussion, commentId: "DC" })),
    ...["add_discussion_reaction", "remove_discussion_reaction"].map(
      (operation) => ({
        operation,
        ...discussion,
        commentId: "DC",
        content: "HEART",
      }),
    ),
    { operation: "add_project_item", ...project, repo: "o/r", issue_number: 1 },
    ...[
      "remove_project_item",
      "archive_project_item",
      "unarchive_project_item",
    ].map((operation) => ({ operation, ...item })),
    {
      operation: "update_project_field",
      ...item,
      field: "Status",
      value: "Done",
    },
    { operation: "clear_project_field", ...item, field: "FIELD" },
    {
      operation: "create_project_draft",
      ...project,
      title: "Draft",
      body: "Plan",
    },
    { operation: "edit_project_draft", ...item, title: "Updated" },
    { operation: "convert_project_draft", ...item, repo: "o/r" },
  ];
  for (const [write, requests] of [
    [false, reads],
    [true, writes],
  ] as const)
    for (const request of requests) {
      const result = await s.call(request, write);
      expect(s.fixture.state.schemaErrors, request.operation).toEqual([]);
      expect(
        ["success", "accepted"],
        `${request.operation}: ${JSON.stringify(result.data)}`,
      ).toContain(result.data.status);
    }
});
it("does not present GraphQL partial data as complete success", async () => {
  const s = await setup();
  s.fixture.state.graphqlErrors = true;
  const result = await s.call({ operation: "list_discussions", repo: "o/r" });
  expect(result.data.status).toBe("partial");
  expect(result.result.details).toMatchObject({ status: "partial" });
});

it("recognizes Enterprise missing-field errors carried in GraphQL extensions", async () => {
  const s = await setup(
    (base) => async (input, init) =>
      String(input).endsWith("/api/graphql")
        ? Response.json({
            errors: [
              {
                message: "Field is not available",
                extensions: { code: "undefinedField" },
              },
            ],
          })
        : base(input, init),
  );
  const result = await s.call({ operation: "list_discussions", repo: "o/r" });
  expect(result.data.status).toBe("unsupported_capability");
});
