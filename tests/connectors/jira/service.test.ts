import { describe, expect, test } from "vitest";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setup } from "./setup";
import { JiraConnections } from "../../../src/main/connectors/jira/connection";
import {
  readOperations,
  writeOperations,
  describeOperation,
} from "../../../src/main/connectors/jira/schema";
import { encodeDocument } from "../../../src/main/connectors/jira/content";

for (const cloud of [false, true])
  describe(cloud ? "Cloud" : "Data Center", () => {
    test("dynamic metadata, create, update, required transition and exact label deltas", async () => {
      const s = await setup(cloud);
      const created = {
        operation: "create_issue",
        project: "TEST",
        issueType: "1",
        fields: { summary: "Bug" },
        description: { format: "markdown", text: "**Details**" },
      };
      expect((await s.call(created, true)).data.status).toBe("required_field");
      expect(s.fixture.state.issues.size).toBe(3);
      created.fields = { ...created.fields, customfield_42: 5 } as any;
      const result = await s.call(created, true);
      expect(result.data.status).toBe("success");
      expect(result.data.key).toBe("TEST-10");
      expect((await s.call(created, true)).data.replayed).toBe(true);
      expect(s.fixture.state.issues.size).toBe(4);
      const description =
        s.fixture.state.issues.get("TEST-10").fields.description;
      expect(cloud ? description.type : description).toBe(
        cloud ? "doc" : "*Details*\n\n",
      );
      expect(
        (
          await s.call(
            {
              operation: "update_issue",
              issue: "TEST-1",
              fields: { unknown_field: 1 },
            },
            true,
          )
        ).data.status,
      ).toBe("invalid_field");
      expect(
        (
          await s.call(
            {
              operation: "update_issue",
              issue: "TEST-1",
              expectedUpdated: "stale",
              fields: { summary: "wrong" },
            },
            true,
          )
        ).data.status,
      ).toBe("conflict");
      expect(
        (
          await s.call(
            {
              operation: "update_issue",
              issue: "TEST-1",
              edits: [{ field: "labels", action: "add", value: "new" }],
            },
            true,
          )
        ).data.status,
      ).toBe("success");
      expect(s.fixture.state.issues.get("TEST-1").fields.labels).toEqual([
        "keep",
        "new",
      ]);
      expect(
        (
          await s.call(
            { operation: "transition_issue", issue: "TEST-1", transition: "2" },
            true,
          )
        ).data.status,
      ).toBe("required_field");
      expect(
        (
          await s.call(
            {
              operation: "transition_issue",
              issue: "TEST-1",
              transition: "2",
              fields: { resolution: { id: "1" } },
            },
            true,
          )
        ).data.status,
      ).toBe("success");
      expect(s.fixture.state.issues.get("TEST-1").fields.status.name).toBe(
        "Done",
      );
    });
    test("search continuation is query/session/account scoped and survives restart", async () => {
      const s = await setup(cloud);
      const request = {
        operation: "search",
        jql: "project = TEST ORDER BY key",
        limit: 2,
      };
      const first = (await s.call(request)).data;
      expect(first.items).toHaveLength(2);
      expect(first.complete).toBe(false);
      const second = (
        await s.call({ ...request, continuation: first.continuation })
      ).data;
      expect(second.items[0].key).toBe("TEST-3");
      expect(second.complete).toBe(true);
      expect(
        (
          await s.call(
            { ...request, continuation: first.continuation },
            false,
            "other",
          )
        ).data.status,
      ).toBe("invalid_continuation");
      expect(
        (
          await s.call({
            ...request,
            jql: "project = OTHER",
            continuation: first.continuation,
          })
        ).data.status,
      ).toBe("invalid_continuation");
      await s.connections.load();
      expect(
        (await s.call({ ...request, continuation: first.continuation })).data
          .items[0].key,
      ).toBe("TEST-3");
      await s.connections.save(s.input);
      expect(
        (await s.call({ ...request, continuation: first.continuation })).data
          .status,
      ).toBe("invalid_continuation");
    });
    test("comments, visibility, worklogs and explicit estimate adjustment", async () => {
      const s = await setup(cloud);
      const comment = (
        await s.call(
          {
            operation: "add_comment",
            issue: "TEST-1",
            body: {
              format: "markdown",
              text: "Hello @{fixture-account|Fixture}",
            },
            visibility: { type: "role", value: "Developers" },
          },
          true,
        )
      ).data;
      expect(comment.status).toBe("success");
      expect(
        (
          await s.call(
            {
              operation: "edit_comment",
              issue: "TEST-1",
              comment: comment.id,
              body: { format: "markdown", text: "Edited" },
              expectedUpdated: "original",
            },
            true,
          )
        ).data.status,
      ).toBe("success");
      expect(s.fixture.state.comments.get(comment.id).visibility).toEqual({
        type: "role",
        value: "Developers",
      });
      const log = (
        await s.call(
          {
            operation: "add_worklog",
            issue: "TEST-1",
            started: "2026-09-14T10:00:00+0800",
            timeSpentSeconds: 3600,
            estimate: { mode: "new", remaining: "2h" },
          },
          true,
        )
      ).data;
      expect(log.status).toBe("success");
      const sent = s.fixture.state.requests.find(
        (r) => r.method === "POST" && r.path.endsWith("/worklog"),
      );
      expect(sent?.query.get("adjustEstimate")).toBe("new");
      expect(sent?.query.get("newEstimate")).toBe("2h");
      expect(
        (
          await s.call(
            {
              operation: "delete_worklog",
              issue: "TEST-1",
              worklog: log.id,
              estimate: { mode: "leave" },
              expectedUpdated: "original",
            },
            true,
          )
        ).data.status,
      ).toBe("success");
      expect(s.fixture.state.worklogs.size).toBe(0);
    });
    test("attachments, session directories, no overwrite and upload", async () => {
      const s = await setup(cloud);
      const downloaded = (
        await s.call({ operation: "download_attachment", attachment: "8" })
      ).data;
      expect(downloaded.status).toBe("success");
      expect(downloaded.artifacts[0].path).toContain(join("session1", "jira"));
      expect(await readFile(downloaded.artifacts[0].path, "utf8")).toBe(
        "fixture attachment bytes",
      );
      const upload = (
        await s.call(
          {
            operation: "upload_attachment",
            issue: "TEST-1",
            filePath: downloaded.artifacts[0].path,
          },
          true,
        )
      ).data;
      expect(upload.status).toBe("success");
      expect(upload.items[0].id).toBe("20");
      const exact = join(s.root, "keep.txt");
      await writeFile(exact, "keep");
      expect(
        (
          await s.call({
            operation: "download_attachment",
            attachment: "8",
            destination: { path: exact },
          })
        ).data.status,
      ).not.toBe("success");
      expect(await readFile(exact, "utf8")).toBe("keep");
    });
    test("batches retain success and report failed items; clone retains created issue", async () => {
      const s = await setup(cloud);
      const batch = (
        await s.call(
          {
            operation: "batch",
            items: [
              {
                action: "update",
                issue: "TEST-1",
                fields: { summary: "Updated" },
              },
              {
                action: "update",
                issue: "TEST-2",
                fields: { customfield_42: "wrong" },
              },
            ],
          },
          true,
        )
      ).data;
      expect(batch.status).toBe("partial");
      expect(batch.results.map((r: any) => r.status)).toEqual([
        "success",
        "invalid_field",
      ]);
      expect(s.fixture.state.issues.get("TEST-1").fields.summary).toBe(
        "Updated",
      );
      s.fixture.state.failPath = `/rest/api/${cloud ? 3 : 2}/issue/TEST-10/attachments`;
      s.fixture.state.failuresLeft = 1;
      s.fixture.state.failStatus = 403;
      const clone = (
        await s.call(
          {
            operation: "clone_issue",
            issue: "TEST-1",
            project: "TEST",
            issueType: "1",
            summary: "Copy",
            copyFields: ["customfield_42", "description"],
            copyLinks: false,
            copyAttachments: true,
          },
          true,
        )
      ).data;
      expect(clone.status).toBe("partial");
      expect(clone.key).toBe("TEST-10");
      expect(s.fixture.state.issues.has("TEST-10")).toBe(true);
    });
    test("planning, filter lifecycle, deletion preview detects changes", async () => {
      const s = await setup(cloud);
      expect(
        (
          await s.call(
            {
              operation: "rank_issues",
              board: "1",
              issues: ["TEST-2"],
              before: "TEST-1",
            },
            true,
          )
        ).data.status,
      ).toBe("success");
      expect(
        (
          await s.call(
            {
              operation: "start_sprint",
              sprint: "6",
              startDate: "2026-09-14T00:00:00Z",
              endDate: "2026-09-28T00:00:00Z",
            },
            true,
          )
        ).data.status,
      ).toBe("success");
      const completion = (
        await s.call(
          {
            operation: "complete_sprint",
            sprint: "5",
            board: "1",
            unfinished: { destination: "backlog" },
          },
          true,
        )
      ).data;
      expect(completion.status).toBe("success");
      expect(completion.results[1].issues).toEqual(["TEST-1", "TEST-2"]);
      expect(s.fixture.state.sprints.get("5").state).toBe("closed");
      const filter = (
        await s.call(
          {
            operation: "create_filter",
            name: "Mine",
            jql: "assignee = currentUser()",
          },
          true,
        )
      ).data;
      expect(filter.id).toBeTruthy();
      expect(
        (
          await s.call(
            { operation: "update_filter", filter: filter.id, name: "New name" },
            true,
          )
        ).data.status,
      ).toBe("success");
      const preview = (
        await s.call({ operation: "preview_delete", issue: "TEST-1" })
      ).data;
      s.fixture.state.issues.get("TEST-1").fields.subtasks.push({ id: "2" });
      expect(
        (
          await s.call(
            {
              operation: "delete_issue",
              issue: "TEST-1",
              preview: preview.preview,
              deleteSubtasks: true,
            },
            true,
          )
        ).data.status,
      ).toBe("conflict");
      const fresh = (
        await s.call({ operation: "preview_delete", issue: "TEST-1" })
      ).data;
      expect(
        (
          await s.call(
            {
              operation: "delete_issue",
              issue: "TEST-1",
              preview: fresh.preview,
              deleteSubtasks: false,
            },
            true,
          )
        ).data.status,
      ).toBe("invalid_request");
      expect(
        (
          await s.call(
            {
              operation: "delete_issue",
              issue: "TEST-1",
              preview: fresh.preview,
              deleteSubtasks: true,
            },
            true,
          )
        ).data.status,
      ).toBe("success");
    });
  });

test("encrypted configuration, failed validation, no secret output and scoped gateway", async () => {
  const s = await setup(true, true);
  expect(await readFile(join(s.root, "jira.json"), "utf8")).not.toContain(
    s.input.token,
  );
  const auth = s.fixture.state.requests[0].auth!;
  expect(auth).toBe(
    "Basic " +
      Buffer.from(`fixture@example.com:${s.input.token}`).toString("base64"),
  );
  expect(s.connections.redact(auth)).not.toContain(s.input.token);
  const restored = new JiraConnections(
    join(s.root, "jira.json"),
    s.encryption,
    s.fetcher,
  );
  await restored.load();
  expect(restored.info().configured).toBe(true);
  s.fixture.state.identityStatus = 401;
  await expect(s.connections.save(s.input)).rejects.toThrow();
  expect(s.service.names()).toEqual([]);
  expect(JSON.stringify(s.connections.info())).not.toContain(s.input.token);
  await s.connections.remove();
  expect(s.connections.info().configured).toBe(false);
});

test("unknown mutations are not retried, including service restart; reads may retry", async () => {
  const s = await setup();
  s.fixture.state.disconnectPath = "/rest/api/2/issue/TEST-1/comment";
  const request = {
    operation: "add_comment",
    issue: "TEST-1",
    body: { format: "markdown", text: "Once" },
  };
  expect((await s.call(request, true)).data.status).toBe("unknown");
  expect((await s.call(request, true)).data.replayed).toBe(true);
  expect(
    s.fixture.state.requests.filter((r) => r.path.endsWith("/comment")).length,
  ).toBe(1);
  s.fixture.state.failPath = "/rest/api/2/search";
  s.fixture.state.failuresLeft = 1;
  expect(
    (await s.call({ operation: "search", jql: "project = TEST" })).data.status,
  ).toBe("success");
  expect(
    s.fixture.state.requests.filter((r) => r.path.endsWith("/search")).length,
  ).toBe(2);
});

test("pending journal failure prevents dispatch; output failure preserves remote success", async () => {
  const s = await setup();
  await mkdir(join(s.artifacts.root, "jira"), { recursive: true });
  await writeFile(join(s.artifacts.root, "jira", "operations"), "blocked");
  expect(
    (
      await s.call(
        {
          operation: "add_comment",
          issue: "TEST-1",
          body: { format: "markdown", text: "No send" },
        },
        true,
      )
    ).data.status,
  ).toBe("storage_error");
  expect(s.fixture.state.commentCount).toBe(0);
});

test("every operation has a strict discoverable schema; content retains native nodes", () => {
  for (const operation of [...readOperations, ...writeOperations])
    expect(
      describeOperation(operation.shape.operation.value).inputSchema,
    ).toBeTruthy();
  const raw = {
    type: "doc" as const,
    version: 1 as const,
    content: [{ type: "extension", attrs: { extensionKey: "custom" } }],
  };
  expect(encodeDocument({ format: "adf", value: raw }, true)).toBe(raw);
  expect(() =>
    encodeDocument({ format: "markdown", text: "<script>x</script>" }, true),
  ).toThrow("无损");
  expect(
    encodeDocument(
      { format: "markdown", text: "| A | B |\n|---|---|\n| X | Y |" },
      true,
    ),
  ).toMatchObject({ content: [{ type: "table" }] });
});

for (const cloud of [false, true])
  test(`operation matrix and native protocol (${cloud ? "Cloud" : "DC"})`, async () => {
    const s = await setup(cloud);
    const reads = [
      { operation: "current_user" },
      { operation: "server_info" },
      {
        operation: "permissions",
        permissions: ["EDIT_ISSUES"],
        issue: "TEST-1",
      },
      { operation: "list_projects" },
      { operation: "read_project", project: "TEST" },
      { operation: "list_fields", limit: 100 },
      { operation: "list_issue_types", project: "TEST" },
      { operation: "create_metadata", project: "TEST", issueType: "1" },
      { operation: "edit_metadata", issue: "TEST-1" },
      { operation: "list_priorities" },
      { operation: "list_resolutions" },
      { operation: "list_link_types" },
      { operation: "list_components", project: "TEST" },
      { operation: "read_component", component: "1" },
      { operation: "list_versions", project: "TEST" },
      { operation: "read_version", version: "1" },
      { operation: "search_users", query: "fixture" },
      { operation: "assignable_users", issue: "TEST-1" },
      { operation: "read_issue", issue: "TEST-1" },
      { operation: "list_comments", issue: "TEST-1" },
      { operation: "changelog", issue: "TEST-1" },
      { operation: "list_worklogs", issue: "TEST-1" },
      { operation: "list_transitions", issue: "TEST-1" },
      { operation: "list_remote_links", issue: "TEST-1" },
      { operation: "list_watchers", issue: "TEST-1" },
      { operation: "read_votes", issue: "TEST-1" },
      { operation: "list_attachments", issue: "TEST-1" },
      { operation: "attachment_settings" },
      { operation: "read_attachment", attachment: "8" },
      { operation: "list_filters" },
      { operation: "list_boards" },
      { operation: "read_board", board: "1" },
      { operation: "board_configuration", board: "1" },
      { operation: "backlog", board: "1" },
      { operation: "board_issues", board: "1" },
      { operation: "list_sprints", board: "1" },
      { operation: "read_sprint", sprint: "5" },
      { operation: "sprint_issues", sprint: "5" },
    ];
    for (const request of reads) {
      const result = (await s.call(request)).data;
      expect(
        result.status,
        `${request.operation}: ${JSON.stringify(result)}`,
      ).toBe("success");
    }
    s.fixture.state.issues.get("TEST-1").fields.issuelinks.push({
      id: "30",
      type: { id: "1" },
      outwardIssue: { key: "TEST-2" },
    });
    const writes = [
      {
        operation: "assign_issue",
        issue: "TEST-1",
        user: cloud ? "fixture-account" : "fixture",
      },
      { operation: "set_parent", issue: "TEST-1", parent: "TEST-2" },
      {
        operation: "link_issues",
        issue: "TEST-1",
        other: "TEST-2",
        type: "1",
        direction: "outward",
      },
      { operation: "unlink_issues", issue: "TEST-1", link: "30" },
      {
        operation: "set_remote_link",
        issue: "TEST-1",
        url: "https://example.com/doc",
        title: "Doc",
      },
      { operation: "delete_remote_link", issue: "TEST-1", link: "1" },
      { operation: "set_watch", issue: "TEST-1", watching: true },
      { operation: "set_watch", issue: "TEST-1", watching: false },
      { operation: "set_vote", issue: "TEST-1", voting: true },
      { operation: "set_vote", issue: "TEST-1", voting: false },
      { operation: "delete_attachment", issue: "TEST-1", attachment: "8" },
      { operation: "move_to_sprint", sprint: "6", issues: ["TEST-1"] },
      { operation: "move_to_backlog", issues: ["TEST-2"] },
      { operation: "set_estimate", issue: "TEST-1", board: "1", value: 5 },
      { operation: "create_sprint", board: "1", name: "New" },
      { operation: "update_sprint", sprint: "6", goal: "Goal" },
      { operation: "create_version", project: "TEST", name: "v1" },
      { operation: "update_version", version: "1", name: "v2" },
      { operation: "release_version", version: "1", releaseDate: "2026-09-14" },
    ];
    for (const request of writes) {
      const result = (await s.call(request, true)).data;
      expect(
        result.status,
        `${request.operation}: ${JSON.stringify(result)}`,
      ).toBe("success");
    }
    const link = s.fixture.state.requests.find(
      (r) => r.method === "POST" && r.path.endsWith("/issueLink"),
    );
    expect(link?.body).toMatchObject({
      inwardIssue: { key: "TEST-1" },
      outwardIssue: { key: "TEST-2" },
    });
    const assignee = s.fixture.state.requests.find((r) =>
      r.path.endsWith("/assignee"),
    );
    expect(assignee?.body).toEqual(
      cloud ? { accountId: "fixture-account" } : { name: "fixture" },
    );
    const comment = (
      await s.call(
        {
          operation: "add_comment",
          issue: "TEST-1",
          body: { format: "markdown", text: "comment" },
        },
        true,
      )
    ).data;
    expect(
      (
        await s.call({
          operation: "read_comment",
          issue: "TEST-1",
          comment: comment.id,
        })
      ).data.data.id,
    ).toBe(comment.id);
    expect(
      (
        await s.call(
          {
            operation: "delete_comment",
            issue: "TEST-1",
            comment: comment.id,
            expectedUpdated: "original",
          },
          true,
        )
      ).data.status,
    ).toBe("success");
    const log = (
      await s.call(
        {
          operation: "add_worklog",
          issue: "TEST-1",
          timeSpentSeconds: 60,
          started: "2026-09-14T00:00:00Z",
          estimate: { mode: "leave" },
        },
        true,
      )
    ).data;
    expect(
      (
        await s.call({
          operation: "read_worklog",
          issue: "TEST-1",
          worklog: log.id,
        })
      ).data.data.id,
    ).toBe(log.id);
    expect(
      (
        await s.call(
          {
            operation: "edit_worklog",
            issue: "TEST-1",
            worklog: log.id,
            timeSpentSeconds: 120,
            started: "2026-09-14T00:00:00Z",
            estimate: { mode: "auto" },
            expectedUpdated: "original",
          },
          true,
        )
      ).data.status,
    ).toBe("success");
    const filter = (
      await s.call(
        { operation: "create_filter", name: "Filter", jql: "project = TEST" },
        true,
      )
    ).data;
    expect(
      (await s.call({ operation: "read_filter", filter: filter.id })).data.data
        .name,
    ).toBe("Filter");
    expect(
      (await s.call({ operation: "run_filter", filter: filter.id })).data.items
        .length,
    ).toBe(3);
    expect(
      (
        await s.call(
          {
            operation: "set_filter_favourite",
            filter: filter.id,
            favourite: true,
          },
          true,
        )
      ).data.status,
    ).toBe("success");
    expect(
      (await s.call({ operation: "delete_filter", filter: filter.id }, true))
        .data.status,
    ).toBe("success");
  });
