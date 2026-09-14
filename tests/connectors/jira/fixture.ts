import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
export async function jiraFixture() {
  const metadata: Record<string, any> = Object.fromEntries(
    [
      ["summary", "string", true],
      ["description", "string", false],
      ["environment", "string", false],
      ["labels", "array", false],
      ["assignee", "user", false],
      ["parent", "issuelink", false],
      ["customfield_42", "number", true],
      ["priority", "priority", false],
      ["project", "project", true],
      ["issuetype", "issuetype", true],
      ["timetracking", "timetracking", false],
      ["fixVersions", "array", false],
      ["components", "array", false],
      ["duedate", "date", false],
      ["reporter", "user", false],
    ].map(([id, type, required]) => [
      id,
      {
        fieldId: id,
        key: id,
        name: id,
        required,
        schema: { type },
        operations: type === "array" ? ["set", "add", "remove"] : ["set"],
      },
    ]),
  );
  const state = {
    identityStatus: 200,
    failPath: "",
    failStatus: 500,
    failuresLeft: 0,
    disconnectPath: "",
    loseResponsePath: "",
    commentCount: 0,
    requests: [] as {
      method: string;
      path: string;
      query: URLSearchParams;
      body: any;
      auth?: string;
    }[],
    issues: new Map<string, any>(),
    comments: new Map<string, any>(),
    worklogs: new Map<string, any>(),
    filters: new Map<string, any>(),
    sprintMembership: new Map([
      ["TEST-1", "5"],
      ["TEST-2", "5"],
      ["TEST-3", "5"],
    ]),
    sprintAtClose: new Map<string, string[]>(),
    sprints: new Map<string, any>([
      ["5", { id: 5, name: "Current", state: "active", originBoardId: 1 }],
      ["6", { id: 6, name: "Next", state: "future", originBoardId: 1 }],
    ]),
  };
  for (let n = 1; n <= 3; n++)
    state.issues.set(`TEST-${n}`, {
      id: String(n),
      key: `TEST-${n}`,
      fields: {
        summary: `Issue ${n}`,
        description: "Original **description**",
        updated: "2026-09-14T01:00:00.000+0000",
        status: { id: n === 3 ? "3" : "1", name: n === 3 ? "Done" : "Open" },
        labels: ["keep"],
        customfield_42: 3,
        project: { key: "TEST" },
        issuetype: { id: "1" },
        subtasks: [],
        issuelinks: [],
        attachment: [{ id: "8", filename: "fixture.txt", size: 24 }],
      },
    });
  let nextId = 10;
  const user = {
    name: "fixture",
    key: "fixture",
    accountId: "fixture-account",
    displayName: "Fixture User",
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://localhost");
    const path = url.pathname.replace(/^\/jira/, "");
    const method = req.method!;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    let body: any;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = raw;
    }
    state.requests.push({
      method,
      path,
      query: url.searchParams,
      body,
      auth: req.headers.authorization,
    });
    const json = (data: any, status = 200) => {
      if (method !== "GET" && path === state.loseResponsePath) {
        req.socket.destroy();
        return;
      }
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    const empty = () => {
      res.writeHead(204);
      res.end();
    };
    if (path.endsWith("/myself")) return json(user, state.identityStatus);
    if (path === state.disconnectPath && method !== "GET") {
      req.socket.destroy();
      return;
    }
    if (path === state.failPath && state.failuresLeft-- > 0)
      return json({ errors: { field: "fixture failure" } }, state.failStatus);
    const cloud = path.startsWith("/rest/api/3");
    const resource = path.replace(/^\/rest\/api\/[23]/, "");
    const page = (rows: any[], key = "values", token = false) => {
      const start = Number(
        token
          ? (body?.nextPageToken ?? 0)
          : (url.searchParams.get("startAt") ?? body?.startAt ?? 0),
      );
      const size = Number(
        url.searchParams.get("maxResults") ?? body?.maxResults ?? 50,
      );
      const end = Math.min(start + size, rows.length);
      return json({
        [key]: rows.slice(start, end),
        ...(token
          ? {
              isLast: end >= rows.length,
              ...(end < rows.length ? { nextPageToken: String(end) } : {}),
            }
          : {
              startAt: start,
              maxResults: size,
              total: rows.length,
              isLast: end >= rows.length,
            }),
      });
    };
    if (/^\/rest\/api\/1.0\/filters\/\d+\/favourite$/.test(path))
      return empty();
    if (resource === "/serverInfo")
      return json({
        version: "9.12.0",
        deploymentType: cloud ? "Cloud" : "Data Center",
      });
    if (resource === "/mypermissions")
      return json({ permissions: { EDIT_ISSUES: { havePermission: true } } });
    if (resource === "/field") return json(Object.values(metadata));
    if (/^\/issue\/createmeta\/TEST\/issuetypes\/1$/.test(resource))
      return page(Object.values(metadata), cloud ? "fields" : "values");
    if (/^\/issue\/createmeta\/TEST\/issuetypes$/.test(resource))
      return page([{ id: "1", name: "Task" }], cloud ? "issueTypes" : "values");
    if (resource === "/search" || resource === "/search/jql")
      return page([...state.issues.values()], "issues", cloud);
    if (resource === "/issue" && method === "POST") {
      const id = String(nextId++);
      const key = "TEST-" + id;
      state.issues.set(key, {
        id,
        key,
        fields: {
          ...body.fields,
          updated: "created",
          subtasks: [],
          issuelinks: [],
          attachment: [],
        },
      });
      return json({ id, key }, 201);
    }
    if (resource.startsWith("/user/")) return json([user]);
    if (resource === "/attachment/meta")
      return json({ enabled: true, uploadLimit: 104857600 });
    if (resource === "/attachment/8") {
      if (method === "DELETE") return empty();
      return json({ id: "8", filename: "fixture.txt", size: 24 });
    }
    if (
      resource === "/attachment/content/8" ||
      path === "/secure/attachment/8/fixture.txt"
    ) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("fixture attachment bytes");
      return;
    }
    if (resource === "/issueLinkType")
      return json({
        issueLinkTypes: [
          {
            id: "1",
            name: "Blocks",
            inward: "is blocked by",
            outward: "blocks",
          },
        ],
      });
    if (resource.startsWith("/issueLink") && method !== "GET") return empty();
    if (resource === "/priority") return json([{ id: "1", name: "High" }]);
    if (resource === "/resolution") return json([{ id: "1", name: "Fixed" }]);
    if (resource === "/project/search") return page([{ id: "1", key: "TEST" }]);
    if (resource === "/project") return json([{ id: "1", key: "TEST" }]);
    if (["/project/TEST", "/project/1"].includes(resource))
      return json({ id: "1", key: "TEST", name: "Test" });
    if (/\/project\/TEST\/(components|versions)$/.test(resource))
      return json([{ id: "1", name: "Release" }]);
    if (/^\/(component|version)\/1$/.test(resource))
      return json({ id: "1", ...body, name: body?.name ?? "Release" });
    if (resource === "/version" && method === "POST") {
      if (body.projectId !== 1)
        return json({ error: "Expected projectId" }, 400);
      return json({ id: "1", ...body });
    }
    if (
      ["/filter/my", "/filter/favourite", "/filter/search"].includes(resource)
    )
      return resource.endsWith("search")
        ? page([...state.filters.values()])
        : json([...state.filters.values()]);
    if (resource === "/filter" && method === "POST") {
      const id = String(nextId++);
      const filter = { id, ...body, owner: user };
      state.filters.set(id, filter);
      return json(filter);
    }
    const filterMatch = resource.match(/^\/filter\/(\d+)(\/favourite)?$/);
    if (filterMatch) {
      const id = filterMatch[1];
      if (filterMatch[2]) return empty();
      const filter = state.filters.get(id);
      if (!filter) return json({}, 404);
      if (method === "DELETE") {
        state.filters.delete(id);
        return empty();
      }
      if (method === "PUT") Object.assign(filter, body);
      return json(filter);
    }
    const match = resource.match(/^\/issue\/([^/]+)(.*)$/);
    if (match) {
      const issue =
        state.issues.get(match[1]) ??
        [...state.issues.values()].find((i) => i.id === match[1]);
      if (!issue) return json({}, 404);
      const suffix = match[2];
      if (suffix === "/editmeta") return json({ fields: metadata });
      if (suffix === "/transitions") {
        if (method === "GET")
          return json({
            transitions: [
              {
                id: "2",
                name: "Resolve",
                to: { id: "3", name: "Done" },
                fields: {
                  resolution: {
                    required: true,
                    operations: ["set"],
                    allowedValues: [{ id: "1", name: "Fixed" }],
                  },
                },
              },
            ],
          });
        if (!body.fields?.resolution)
          return json({ errors: { resolution: "required" } }, 400);
        issue.fields.status = { id: "3", name: "Done" };
        return empty();
      }
      if (suffix === "/attachments")
        return json([{ id: "20", filename: "uploaded.txt" }]);
      if (suffix === "/assignee") {
        issue.fields.assignee = body;
        return empty();
      }
      if (suffix === "/watchers" || suffix === "/votes")
        return method === "GET"
          ? json({ watchers: [user], votes: 1 })
          : empty();
      if (suffix.startsWith("/remotelink"))
        return method === "GET" ? json([]) : empty();
      if (suffix === "/changelog")
        return page([
          {
            id: "1",
            created: "2026-09-14",
            items: [{ field: "status", fromString: "Open", toString: "Done" }],
          },
        ]);
      const coll = suffix.match(/^\/(comment|worklog)(?:\/(\d+))?$/);
      if (coll) {
        const rows = coll[1] === "comment" ? state.comments : state.worklogs;
        const id = coll[2];
        if (!id && method === "GET")
          return page(
            [...rows.values()],
            coll[1] === "comment" ? "comments" : "worklogs",
          );
        if (method === "POST") {
          const id = String(nextId++);
          const value = { id, ...body, updated: "original", author: user };
          rows.set(id, value);
          if (coll[1] === "comment") state.commentCount++;
          return json(value, 201);
        }
        if (!rows.has(id)) return json({}, 404);
        if (method === "DELETE") {
          rows.delete(id);
          return empty();
        }
        if (method === "PUT")
          rows.set(id, { ...rows.get(id), ...body, updated: "edited" });
        return json(rows.get(id));
      }
      if (!suffix) {
        if (method === "DELETE") {
          state.issues.delete(issue.key);
          return empty();
        }
        if (method === "PUT") {
          Object.assign(issue.fields, body.fields);
          for (const [field, edits] of Object.entries<any[]>(body.update ?? {}))
            for (const edit of edits) {
              if ("add" in edit)
                issue.fields[field] = [...issue.fields[field], edit.add];
              if ("remove" in edit)
                issue.fields[field] = issue.fields[field].filter(
                  (v: any) => v !== edit.remove,
                );
            }
          return empty();
        }
        return json({
          ...issue,
          ...(url.searchParams.get("expand")?.includes("changelog")
            ? { changelog: { startAt: 0, total: 1, histories: [{ id: "1" }] } }
            : {}),
        });
      }
    }
    if (path === "/rest/agile/1.0/board")
      return page([{ id: 1, name: "Board", type: "scrum" }]);
    if (path === "/rest/agile/1.0/board/1")
      return json({ id: 1, name: "Board" });
    if (path === "/rest/agile/1.0/board/1/configuration")
      return json({
        ranking: { rankCustomFieldId: 99 },
        estimation: { field: { fieldId: "customfield_42" } },
        columnConfig: {
          columns: [{ statuses: [{ id: "1" }] }, { statuses: [{ id: "3" }] }],
        },
      });
    if (path === "/rest/agile/1.0/board/1/sprint")
      return page([...state.sprints.values()]);
    if (/^\/rest\/agile\/1.0\/board\/1\/(backlog|issue)$/.test(path))
      return page([...state.issues.values()], "issues");
    if (path === "/rest/agile/1.0/sprint" && method === "POST") {
      const id = String(nextId++);
      state.sprints.set(id, { id: Number(id), state: "future", ...body });
      return json(state.sprints.get(id));
    }
    const sprintMatch = path.match(
      /^\/rest\/agile\/1.0\/sprint\/(\d+)(\/issue)?$/,
    );
    if (sprintMatch) {
      if (sprintMatch[2]) {
        if (method === "GET")
          return page(
            [...state.issues.values()].filter(
              (issue) =>
                state.sprintMembership.get(issue.key) === sprintMatch[1],
            ),
            "issues",
          );
        for (const key of body.issues)
          state.sprintMembership.set(key, sprintMatch[1]);
        return empty();
      }
      const sprint = state.sprints.get(sprintMatch[1]);
      if (!sprint) return json({}, 404);
      if (method === "POST" || method === "PUT") {
        if (body.state === "closed")
          state.sprintAtClose.set(
            sprintMatch[1],
            [...state.sprintMembership]
              .filter(([, id]) => id === sprintMatch[1])
              .map(([key]) => key),
          );
        Object.assign(sprint, body);
      }
      return json(sprint);
    }
    if (path === "/rest/agile/1.0/backlog/issue") {
      for (const key of body.issues) state.sprintMembership.delete(key);
      return empty();
    }
    if (path === "/rest/agile/1.0/issue/rank" || /\/estimation$/.test(path))
      return empty();
    return json({ error: "Unhandled fixture route", path, method }, 404);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/jira`,
    state,
    metadata,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  };
}
