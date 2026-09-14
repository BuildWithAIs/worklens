import { createServer } from "node:http";
import { schema as official } from "@octokit/graphql-schema";
import {
  buildClientSchema,
  parse,
  validate,
  getVariableValues,
  type OperationDefinitionNode,
  type IntrospectionQuery,
} from "graphql";
// GitHub's published schema has legacy interface/deprecation inconsistencies.
// Trust the server schema itself; still validate every query and variable below.
const schema = buildClientSchema(official.json as IntrospectionQuery, {
  assumeValid: true,
});
export const HEAD = "a".repeat(40);
export const OTHER_HEAD = "b".repeat(40);
export async function githubFixture() {
  const state = {
    identityStatus: 200,
    comments: 0,
    writes: 0,
    loseWriteResponse: false,
    head: HEAD,
    reviewHead: HEAD,
    updatedAt: "2026-09-14T00:00:00Z",
    paged: false,
    crossHostPage: false,
    responseStatus: 0,
    retryAfter: "",
    graphqlErrors: false,
    schemaErrors: [] as string[],
    requests: [] as {
      method: string;
      path: string;
      body: any;
      authorization?: string;
    }[],
    patch: "@@ -1,2 +1,3 @@\n first\n+added\n last",
    workflow:
      "on:\n  workflow_dispatch:\n    inputs:\n      target:\n        required: true\n        type: choice\n        options: [test, prod]\n",
  };
  let origin = "";
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body: any = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = raw;
    }
    const url = new URL(req.url!, origin);
    const path = decodeURIComponent(url.pathname).replace(/^\/api\/v3/, "");
    state.requests.push({
      method: req.method!,
      path: url.pathname + url.search,
      body,
      authorization: req.headers.authorization,
    });
    const send = (
      data: unknown,
      status = 200,
      headers: Record<string, string> = {},
    ) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(status === 204 ? undefined : JSON.stringify(data));
    };
    if (state.responseStatus && path !== "/user")
      return send(
        {
          message:
            state.responseStatus === 403
              ? "API rate limit exceeded"
              : "fixture error",
        },
        state.responseStatus,
        { ...(state.retryAfter ? { "retry-after": state.retryAfter } : {}) },
      );
    if (path === "/user")
      return send(
        state.identityStatus === 200
          ? { id: 1, login: "fixture-user" }
          : { message: "Bad credentials" },
        state.identityStatus,
        { "x-github-enterprise-version": "3.17.0" },
      );
    const pageInfo = { hasNextPage: false, endCursor: null };
    const comment = {
      id: "DC",
      databaseId: 7,
      body: "A comment",
      url: `${origin}/o/r/discussions/1#comment-7`,
      discussion: { id: "DISC" },
      pullRequest: { id: "PR" },
    };
    const project = {
      id: "PROJECT",
      number: 1,
      title: "Planning",
      url: `${origin}/orgs/o/projects/1`,
      viewerCanUpdate: true,
    };
    const field = {
      __typename: "ProjectV2SingleSelectField",
      id: "FIELD",
      name: "Status",
      dataType: "SINGLE_SELECT",
      options: [{ id: "OPT", name: "Done" }],
    };
    const discussion = {
      id: "DISC",
      number: 1,
      title: "Help",
      body: "Question",
      url: `${origin}/o/r/discussions/1`,
      category: { id: "CATEGORY", isAnswerable: true },
      comments: { nodes: [comment], pageInfo },
    };
    if (path === "/api/graphql" || path === "/graphql") {
      try {
        const document = parse(body.query);
        const errors = validate(schema, document);
        const operation = document.definitions.find(
          (d) => d.kind === "OperationDefinition",
        ) as OperationDefinitionNode;
        const variables = getVariableValues(
          schema,
          operation.variableDefinitions ?? [],
          body.variables ?? {},
        );
        const messages = [...errors, ...(variables.errors ?? [])].map(
          (e) => e.message,
        );
        if (messages.length) {
          state.schemaErrors.push(...messages);
          return send({
            errors: messages.map((message) => ({
              message,
              type: "validation",
            })),
          });
        }
        if (state.graphqlErrors)
          return send({
            data: { partial: true },
            errors: [
              {
                message: "Fixture partial failure",
                path: ["node"],
                type: "FORBIDDEN",
              },
            ],
          });
        const root = operation.selectionSet.selections[0];
        if (root.kind !== "Field")
          return send({ errors: [{ message: "invalid fixture query" }] });
        const fieldName = root.name.value;
        if (operation.operation === "mutation") {
          state.writes++;
          return send({
            data: {
              [fieldName]: {
                clientMutationId: null,
                issue: {
                  id: "ISSUE",
                  number: 1,
                  url: `${origin}/o/r/issues/1`,
                },
                discussion,
                comment,
                thread: {
                  id: "THREAD",
                  isResolved: fieldName === "resolveReviewThread",
                },
                pullRequest: { id: "PR", url: `${origin}/o/r/pull/1` },
                commit: {
                  oid: OTHER_HEAD,
                  url: `${origin}/o/r/commit/${OTHER_HEAD}`,
                },
                ref: { name: "feature" },
                item: {
                  id: "ITEM",
                  isArchived: fieldName === "archiveProjectV2Item",
                  content: {
                    id: "ISSUE",
                    number: 1,
                    url: `${origin}/o/r/issues/1`,
                  },
                },
                projectV2Item: { id: "ITEM" },
                projectItem: { id: "ITEM" },
                draftIssue: { id: "DRAFT", title: "Draft" },
                mergeQueueEntry: { id: "QUEUE" },
                deletedItemId: "ITEM",
              },
            },
          });
        }
        if (["organization", "user"].includes(fieldName))
          return send({
            data: {
              [fieldName]: {
                projectV2: project,
                projectsV2: { nodes: [project], pageInfo },
              },
            },
          });
        if (fieldName === "search")
          return send({
            data: {
              search: { discussionCount: 1, nodes: [discussion], pageInfo },
            },
          });
        const type =
          {
            REPO: "Repository",
            PR: "PullRequest",
            THREAD: "PullRequestReviewThread",
            DC: "DiscussionComment",
            CATEGORY: "DiscussionCategory",
            PROJECT: "ProjectV2",
            ITEM: "ProjectV2Item",
            DISC: "Discussion",
          }[body.variables.id as string] ?? "Issue";
        return send({
          data: {
            node: {
              __typename: type,
              id: body.variables.id,
              repository: { id: "REPO" },
              project: { id: "PROJECT" },
              pullRequest: { id: "PR" },
              discussion,
              content: { __typename: "DraftIssue", id: "DRAFT" },
              fields: { nodes: [field], pageInfo },
              views: {
                nodes: [
                  {
                    id: "VIEW",
                    name: "Board",
                    number: 1,
                    layout: "BOARD_LAYOUT",
                  },
                ],
                pageInfo,
              },
              items: { nodes: [{ id: "ITEM" }], pageInfo },
              fieldValues: { nodes: [], pageInfo },
              reviewThreads: {
                nodes: [{ id: "THREAD", isResolved: false }],
                pageInfo,
              },
              comments: { nodes: [comment], pageInfo },
              replies: { nodes: [comment], pageInfo },
              discussionCategories: {
                nodes: [{ id: "CATEGORY", name: "Q&A", isAnswerable: true }],
                pageInfo,
              },
              discussions: { nodes: [discussion], pageInfo },
            },
          },
        });
      } catch (e) {
        return send({ errors: [{ message: String(e) }] });
      }
    }
    const issue = (n = 1) => ({
      id: 100 + n,
      node_id: "ISSUE",
      number: n,
      title: "Fixture issue",
      body: "Details",
      state: "open",
      updated_at: state.updatedAt,
      html_url: `${origin}/o/r/issues/${n}`,
      labels: [{ name: "existing" }],
    });
    if (req.method === "GET" && /\/repos\/[^/]+\/[^/]+$/.test(path))
      return send({
        id: 2,
        node_id: "REPO",
        name: "r",
        full_name: "o/r",
        default_branch: "main",
        allow_squash_merge: true,
        html_url: `${origin}/o/r`,
      });
    if (
      req.method === "GET" &&
      path.startsWith("/repos/") &&
      path.endsWith("/issues")
    )
      return send(
        [issue(Number(url.searchParams.get("page") ?? 1))],
        200,
        (state.paged && !url.searchParams.has("page")) ||
          (state.paged && url.searchParams.get("page") === "1")
          ? {
              link: `<${state.crossHostPage ? "https://evil.test" : origin}/api/v3/repos/o/r/issues?page=2&per_page=30>; rel="next"`,
            }
          : {},
      );
    if (req.method === "GET" && /\/issues\/\d+$/.test(path))
      return send(issue(Number(path.split("/").at(-1))));
    if (req.method === "GET" && /\/pulls\/\d+$/.test(path))
      return send({
        id: 3,
        node_id: "PR",
        number: 1,
        state: "open",
        head: { sha: state.head, ref: "feature" },
        base: { sha: HEAD, ref: "main" },
        mergeable: true,
        mergeable_state: "clean",
        draft: false,
        html_url: `${origin}/o/r/pull/1`,
      });
    if (req.method === "GET" && path.endsWith("/files"))
      return send([{ filename: "README.md", patch: state.patch }]);
    if (req.method === "GET" && /\/reviews\/\d+$/.test(path))
      return send({ id: 5, commit_id: state.reviewHead, state: "PENDING" });
    if (req.method === "GET" && path.includes("/branches/"))
      return send({
        name: path.split("/").at(-1),
        protected: false,
        commit: { sha: state.head },
      });
    if (req.method === "GET" && path.includes("/git/ref/"))
      return send({ ref: "refs/tags/v1", object: { sha: state.head } });
    if (req.method === "GET" && path.includes("/commits/"))
      return send({ sha: state.head, files: [] });
    if (req.method === "GET" && path.includes("/actions/workflows/"))
      return send({ id: 1, path: ".github/workflows/ci.yml", state: "active" });
    if (req.method === "GET" && path.includes("/contents/")) {
      if (req.headers.accept?.includes("raw")) {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("fixture file bytes");
        return;
      }
      const content = path.includes(".github/workflows")
        ? state.workflow
        : "fixture file bytes";
      return send({
        path: "README.md",
        sha: HEAD,
        encoding: "base64",
        size: content.length,
        content: Buffer.from(content).toString("base64"),
      });
    }
    if (req.method === "GET" && /\/releases\/\d+$/.test(path))
      return send({ id: 1, tag_name: "v1", draft: true });
    if (req.method === "GET" && /\/releases\/assets\/\d+$/.test(path)) {
      if (req.headers.accept === "application/octet-stream") {
        res.writeHead(200);
        res.end("asset bytes");
        return;
      }
      return send({ id: 1, name: "release.txt" });
    }
    if (req.method === "GET" && path.endsWith("/logs")) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("Step 1\nError: fixture failure\n");
      return;
    }
    if (req.method === "GET" && path.startsWith("/search/"))
      return send({
        total_count: 1500,
        incomplete_results: true,
        items: [issue()],
      });
    if (req.method !== "GET") {
      state.writes++;
      if (path.endsWith("/comments") && req.method === "POST") {
        state.comments++;
        if (state.loseWriteResponse) {
          req.socket.destroy();
          return;
        }
      }
      if (path.endsWith("/merge"))
        return send({ merged: true, sha: OTHER_HEAD });
      if (path.endsWith("/dispatches")) return send(undefined, 204);
      if (req.method === "DELETE" || req.method === "PUT")
        return send(undefined, 204);
      return send(
        {
          id: state.writes,
          node_id: "ISSUE",
          html_url: `${origin}/o/r/issues/1`,
          ...body,
        },
        201,
      );
    }
    if (
      ["/user/repos", "/user/orgs"].includes(path) ||
      path.endsWith("/comments")
    )
      return send([]);
    return send({ message: `No fixture for ${req.method} ${path}` }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    url: origin,
    state,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  };
}
