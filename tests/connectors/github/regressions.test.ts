import { expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { setup } from "./setup";
import { HEAD } from "./fixture";

it("keeps mutation bodies and local paths out of REST preflight URLs", async () => {
  const gets: URL[] = [];
  const s = await setup((base) => async (input, init) => {
    if (init?.method === "GET") gets.push(new URL(String(input)));
    return base(input, init);
  });
  const result = await s.call(
    {
      operation: "create_review",
      repo: "o/r",
      pull_number: 1,
      expectedHeadSha: HEAD,
      event: "COMMENT",
      body: "private review".repeat(2000),
      comments: [
        { path: "README.md", body: "inline draft", line: 2, side: "RIGHT" },
      ],
    },
    true,
  );
  expect(result.data.status).toBe("success");
  const preflights = gets.filter((url) => url.pathname.includes("/pulls/"));
  expect(preflights.length).toBeGreaterThan(1);
  for (const url of preflights)
    expect(
      [...url.searchParams.keys()].every((key) =>
        ["per_page", "page"].includes(key),
      ),
    ).toBe(true);
  gets.length = 0;
  await s.call(
    {
      operation: "commit_files",
      repo: "o/r",
      branch: "main",
      expectedHeadSha: HEAD,
      message: "private commit",
      additions: [{ path: "README.md", contents: "private contents" }],
    },
    true,
  );
  expect(gets.length).toBeGreaterThan(0);
  for (const url of gets) expect(url.search).toBe("");
});

it("allows star/unstar/star while replaying only the same invocation", async () => {
  const s = await setup();
  const request = { operation: "star_repository", repo: "o/r" };
  await s.call(request, true);
  await s.call({ ...request, operation: "unstar_repository" }, true);
  const third = await s.call(request, true, "session1", undefined, "third");
  const retry = await s.call(request, true, "session1", undefined, "third");
  expect(third.data.status).toBe("success");
  expect(third.data.replayed).toBeUndefined();
  expect(retry.data.replayed).toBe(true);
  expect(
    s.fixture.state.requests
      .filter((r) => r.path.includes("/starred/"))
      .map((r) => r.method),
  ).toEqual(["PUT", "DELETE", "PUT"]);
  const mismatch = await s.call(
    { ...request, operation: "unstar_repository" },
    true,
    "session1",
    undefined,
    "third",
  );
  expect(mismatch.data.status).toBe("invalid_request");
  expect(s.fixture.state.writes).toBe(3);
});

it("bounds partial GraphQL output and makes very long Unicode strings readable in 200-line pages", async () => {
  const body = '中文🙂quoted"line\n'.repeat(12000);
  const s = await setup(
    (base) => async (input, init) =>
      String(input).endsWith("/api/graphql")
        ? Response.json({
            data: { body },
            errors: [{ message: "partial failure", type: "FORBIDDEN" }],
          })
        : base(input, init),
  );
  const response = await s.call({
    operation: "list_projects",
    owner: "o",
    ownerType: "organization",
  });
  expect(response.data.status).toBe("partial");
  expect(response.data.truncated).toBe(true);
  expect(
    (response.result.content[0] as { text: string }).text.length,
  ).toBeLessThan(10000);
  const raw = JSON.parse(await readFile(response.data.rawResultPath, "utf8"));
  expect(raw.detail.data.body).toBe(body);
  const lines = (await readFile(response.data.resultPath, "utf8")).split("\n");
  expect(lines.length).toBeGreaterThan(400);
  expect(lines.every((line) => Buffer.byteLength(line) <= 200)).toBe(true);
  // Removing only presentation line breaks reconstructs the exact JSON values.
  expect(JSON.parse(lines.join(""))).toEqual(raw);
  const tool = createReadToolDefinition(s.root);
  for (const offset of [1, 201, 401]) {
    const result = await tool.execute(
      "read",
      { path: response.data.resultPath, offset, limit: 200 },
      undefined,
      undefined,
      {} as any,
    );
    expect((result.content[0] as { text: string }).text).toContain(
      lines.slice(offset - 1, offset + 199).join("\n"),
    );
  }
  expect(response.data.preview).toBe(
    lines.slice(0, response.data.previewLines).join("\n"),
  );
  expect(response.data.nextOffset).toBe(response.data.previewLines + 1);
});

it("retains full results and successful remote state if retrieval storage fails", async () => {
  const s = await setup();
  const body = "saved remotely ".repeat(2000);
  vi.spyOn(s.artifacts, "save").mockRejectedValue(new Error("disk full"));
  const result = await s.call(
    { operation: "add_comment", repo: "o/r", issue_number: 1, body },
    true,
  );
  expect(result.data.status).toBe("success");
  expect(result.data.retrievalError).toBeTruthy();
  expect(result.data.truncated).toBeUndefined();
  expect(result.data.resultPath).toBeUndefined();
  expect(JSON.stringify(result.data)).toContain(body);
  expect(s.fixture.state.comments).toBe(1);
});

it("reads missing project field types and follows nested field pagination without claiming completeness", async () => {
  let secondPage = false;
  const s = await setup((base) => async (input, init) => {
    const response = await base(input, init); // Fixture validates queries against the pinned official schema.
    if (!String(input).endsWith("/api/graphql")) return response;
    expect((await response.clone().json()).errors).toBeUndefined();
    const request = JSON.parse(String(init?.body));
    if (request.query.includes("fieldValueByName")) {
      secondPage = request.variables.after === "users-next";
      return Response.json({
        data: {
          node: {
            fieldValueByName: {
              __typename: "ProjectV2ItemFieldUserValue",
              field: { id: "ASSIGNEES", name: "Assignees" },
              users: {
                nodes: [{ login: "second" }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      });
    }
    if (!request.query.includes("fieldValues(")) return response;
    for (const type of [
      "User",
      "Label",
      "Milestone",
      "Repository",
      "PullRequest",
      "Reviewer",
    ])
      expect(request.query).toContain(`... on ProjectV2ItemField${type}Value`);
    return Response.json({
      data: {
        node: {
          fieldValues: {
            nodes: [
              {
                __typename: "ProjectV2ItemFieldUserValue",
                field: { id: "ASSIGNEES", name: "Assignees" },
                users: {
                  nodes: [{ login: "first" }],
                  pageInfo: { hasNextPage: true, endCursor: "users-next" },
                },
              },
              {
                __typename: "ProjectV2ItemFieldLabelValue",
                field: { id: "LABELS", name: "Labels" },
                labels: {
                  nodes: [{ name: "bug" }],
                  pageInfo: { hasNextPage: false },
                },
              },
              {
                __typename: "ProjectV2ItemFieldMilestoneValue",
                field: { name: "Milestone" },
                milestone: { title: "v1" },
              },
              {
                __typename: "ProjectV2ItemFieldRepositoryValue",
                field: { name: "Repository" },
                repository: { nameWithOwner: "o/r" },
              },
              {
                __typename: "ProjectV2ItemFieldPullRequestValue",
                field: { name: "PRs" },
                pullRequests: {
                  nodes: [{ number: 1 }],
                  pageInfo: { hasNextPage: false },
                },
              },
              {
                __typename: "ProjectV2ItemFieldReviewerValue",
                field: { name: "Reviewers" },
                reviewers: {
                  nodes: [{ __typename: "Team", slug: "dev" }],
                  pageInfo: { hasNextPage: false },
                },
              },
              { __typename: "FutureFieldValue" },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    });
  });
  const first = await s.call({
    operation: "project_item_fields",
    owner: "o",
    ownerType: "organization",
    number: 1,
    itemId: "ITEM",
  });
  expect(s.fixture.state.schemaErrors).toEqual([]);
  expect(first.data.fieldsPageComplete).toBe(true);
  expect(first.data.complete).toBe(false);
  expect(first.data.unsupportedFields).toEqual([{ type: "FutureFieldValue" }]);
  expect(first.data.items[0].users.nodes[0].login).toBe("first");
  const next = await s.call({
    operation: "continue",
    continuation: first.data.fieldContinuations[0].continuation,
  });
  expect(s.fixture.state.schemaErrors).toEqual([]);
  expect(secondPage).toBe(true);
  expect(next.data.complete).toBe(true);
  expect(next.data.items[0].users.nodes[0].login).toBe("second");
});

it("returns small reads inline and saves large successful reads with exact recovery", async () => {
  let large = false;
  const body = "A long issue body ".repeat(4000);
  const s = await setup((base) => async (input, init) => {
    if (
      large &&
      init?.method === "GET" &&
      new URL(String(input)).pathname.endsWith("/issues")
    )
      return Response.json([{ number: 1, body }]);
    return base(input, init);
  });
  const small = await s.call({
    operation: "read_issue",
    repo: "o/r",
    issue_number: 1,
  });
  expect(small.data.status).toBe("success");
  expect(small.data.truncated).toBeUndefined();
  large = true;
  const result = await s.call({ operation: "list_issues", repo: "o/r" });
  expect(result.data.status).toBe("success");
  expect(result.data.truncated).toBe(true);
  expect(JSON.stringify(result.data).length).toBeLessThan(10000);
  expect(await readFile(result.data.rawResultPath, "utf8")).toContain(body);
});
