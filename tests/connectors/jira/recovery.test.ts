import { afterEach, expect, test, vi } from "vitest";
import { basename, dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { serializeConversation } from "@earendil-works/pi-coding-agent";
import * as storage from "../../../src/main/storage";
import { JiraHttp, ReadLimiter } from "../../../src/main/connectors/jira/http";
import { JiraService } from "../../../src/main/connectors/jira/service";
import { normalizeSettings } from "../../../src/main/connectors/jira/connection";
import { setup } from "./setup";
afterEach(() => vi.restoreAllMocks());

test("final journal failure preserves success; restarted service replays unknown without sending", async () => {
  const s = await setup();
  const original = storage.atomicJson;
  let writes = 0;
  vi.spyOn(storage, "atomicJson").mockImplementation((path, value) => {
    if (basename(dirname(path)) === "operations" && ++writes > 1)
      return Promise.reject(new Error("ENOSPC"));
    return original(path, value);
  });
  const request = {
    operation: "add_comment",
    issue: "TEST-1",
    body: { format: "markdown", text: "Once" },
  };
  const first = (await s.call(request, true)).data;
  expect(first.status).toBe("success");
  expect(first.journalWarning).toContain("本地完成日志保存失败");
  expect(first.id).toBeTruthy();
  const restarted = new JiraService(s.connections, s.artifacts, s.fetcher);
  const raw = await restarted
    .tools("session1", () => "run1")[1]
    .execute(
      "retry",
      { request },
      new AbortController().signal,
      undefined,
      {} as never,
    );
  expect(JSON.parse((raw.content[0] as { text: string }).text)).toMatchObject({
    status: "unknown",
    replayed: true,
  });
  expect(s.fixture.state.commentCount).toBe(1);
});

test("output persistence failure preserves remote success and long content remains retrievable through Pi compaction", async () => {
  const s = await setup();
  s.fixture.state.issues.get("TEST-1").fields.description =
    "long document ".repeat(3000);
  const result = await s.call({ operation: "read_issue", issue: "TEST-1" });
  expect(result.data.resultPath).toContain(join("session1", "jira"));
  const compacted = serializeConversation([
    {
      role: "toolResult",
      toolCallId: "1",
      toolName: "jira_read",
      content: result.result.content,
      isError: false,
      timestamp: 0,
    },
  ]);
  expect(compacted).toContain(result.data.resultPath);
  const stored = JSON.parse(await readFile(result.data.resultPath, "utf8"));
  expect(stored.data.fields.description).toBe(
    s.fixture.state.issues.get("TEST-1").fields.description,
  );
  vi.spyOn(s.artifacts, "save").mockRejectedValue(new Error("ENOSPC"));
  const written = (
    await s.call(
      {
        operation: "add_comment",
        issue: "TEST-1",
        body: { format: "markdown", text: "x".repeat(3000) },
      },
      true,
    )
  ).data;
  expect(written.status).toBe("success");
  expect(written.retrievalError).toContain("ENOSPC");
  expect(s.fixture.state.commentCount).toBe(1);
});

test("operation logs cannot cross sessions, and batch previews detect drift before any mutation", async () => {
  const s = await setup();
  const first = (
    await s.call(
      {
        operation: "add_comment",
        issue: "TEST-1",
        body: { format: "markdown", text: "Logged" },
      },
      true,
    )
  ).data;
  expect(
    (
      await s.call({
        operation: "read_operation",
        operationId: first.operationId,
      })
    ).data.data.status,
  ).toBe("success");
  expect(
    (
      await s.call(
        { operation: "read_operation", operationId: first.operationId },
        false,
        "other",
      )
    ).data.status,
  ).toBe("invalid_target");
  const items = [
    { action: "update", issue: "TEST-1", fields: { summary: "A" } },
    { action: "update", issue: "TEST-2", fields: { summary: "B" } },
  ];
  const preview = (await s.call({ operation: "preview_batch", items })).data;
  s.fixture.state.issues.get("TEST-2").fields.updated = "changed";
  const batch = (
    await s.call({ operation: "batch", items, preview: preview.preview }, true)
  ).data;
  expect(batch.status).toBe("conflict");
  expect(s.fixture.state.issues.get("TEST-1").fields.summary).toBe("Issue 1");
});

test("scoped identity discovery never receives credentials and validates tenant binding", async () => {
  const s = await setup(true);
  const result = await s.connections.save({
    ...s.input,
    tokenType: "scoped",
    cloudId: undefined,
  });
  expect(result.cloudId).toBe("cloud-123");
  await expect(
    s.connections.save({
      ...s.input,
      tokenType: "scoped",
      cloudId: "different",
    }),
  ).rejects.toThrow("Cloud ID");
  expect(s.service.names()).toEqual([]);
  expect(() =>
    normalizeSettings({ ...s.input, url: "https://user:pass@example.com" }),
  ).toThrow();
  expect(() =>
    normalizeSettings({ ...s.input, url: "http://example.com" }),
  ).toThrow("HTTPS");
});

test("attachment redirects never carry authorization; foreign targets and traversal fail before network", async () => {
  const s = await setup();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "https://cdn.example/file?signed=1" },
      }),
    )
    .mockResolvedValueOnce(new Response("bytes"));
  const http = new JiraHttp(s.connections.snapshot(), undefined, fetcher);
  expect(
    await (await http.download("/secure/attachment/8/fixture.txt")).text(),
  ).toBe("bytes");
  expect(fetcher.mock.calls[0][1]?.headers).toHaveProperty("Authorization");
  expect(fetcher.mock.calls[1][1]?.headers).toBeUndefined();
  expect(() => http.issueId("https://other.example/browse/TEST-1")).toThrow(
    "不属于",
  );
  await expect(http.request("/../outside")).rejects.toThrow("范围");
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test("read rate limits honor long Retry-After and cancelled writes preserve unknown outcome", async () => {
  const s = await setup();
  const limited = vi.fn<typeof fetch>(
    async () =>
      new Response(null, { status: 429, headers: { "Retry-After": "90" } }),
  );
  await expect(
    new JiraHttp(s.connections.snapshot(), undefined, limited).json(
      "/rest/api/2/issue/TEST-1",
    ),
  ).rejects.toMatchObject({ code: "rate_limit" });
  expect(limited).toHaveBeenCalledTimes(1);
  const controller = new AbortController();
  const sent = vi.fn<typeof fetch>(async () => {
    controller.abort();
    throw new Error("cancelled after dispatch");
  });
  await expect(
    new JiraHttp(s.connections.snapshot(), controller.signal, sent).json(
      "/rest/api/2/issue",
      "POST",
      { fields: {} },
    ),
  ).rejects.toMatchObject({ code: "unknown" });
  expect(sent).toHaveBeenCalledTimes(1);
});

test("queued reads can be cancelled and subsequent requests still execute", async () => {
  const limiter = new ReadLimiter(1);
  let release!: () => void;
  const first = limiter.run(
    new AbortController().signal,
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const controller = new AbortController();
  let entered = false;
  const second = limiter.run(controller.signal, async () => {
    entered = true;
  });
  controller.abort(new Error("cancelled"));
  await expect(second).rejects.toThrow("cancelled");
  expect(entered).toBe(false);
  release();
  await first;
  expect(
    await limiter.run(new AbortController().signal, async () => "ok"),
  ).toBe("ok");
});

test("strict contracts reject approval flags, invalid input and cross-site writes before network", async () => {
  const s = await setup();
  const before = s.fixture.state.requests.length;
  expect(
    (
      await s.call(
        {
          operation: "add_comment",
          issue: "TEST-1",
          body: { format: "markdown", text: "no" },
          confirmed: true,
        },
        true,
      )
    ).data.status,
  ).toBe("invalid_request");
  expect(
    (
      await s.call(
        { operation: "delete_issue", issue: "TEST-1", deleteSubtasks: false },
        true,
      )
    ).data.status,
  ).toBe("invalid_request");
  expect(
    (
      await s.call(
        {
          operation: "add_comment",
          issue: "https://foreign.example/browse/TEST-1",
          body: { format: "markdown", text: "no" },
        },
        true,
      )
    ).data.status,
  ).toBe("invalid_target");
  expect(s.fixture.state.requests.length).toBe(before);
});

test.each(["create_issue", "add_comment", "add_worklog"])(
  "committed %s with lost response is not duplicated",
  async (operation) => {
    const s = await setup();
    const requests = {
      create_issue: {
        operation,
        project: "TEST",
        issueType: "1",
        fields: { summary: "Committed", customfield_42: 2 },
      },
      add_comment: {
        operation,
        issue: "TEST-1",
        body: { format: "markdown", text: "Committed" },
      },
      add_worklog: {
        operation,
        issue: "TEST-1",
        started: "2026-09-14T00:00:00Z",
        timeSpentSeconds: 60,
        estimate: { mode: "leave" },
      },
    };
    s.fixture.state.loseResponsePath =
      operation === "create_issue"
        ? "/rest/api/2/issue"
        : `/rest/api/2/issue/TEST-1/${operation === "add_comment" ? "comment" : "worklog"}`;
    const request = requests[operation as keyof typeof requests];
    const first = (await s.call(request, true)).data;
    expect(first.status).toBe("unknown");
    expect((await s.call(request, true)).data.replayed).toBe(true);
    expect(
      s.fixture.state.requests.filter(
        (r) =>
          r.method === "POST" && r.path === s.fixture.state.loseResponsePath,
      ),
    ).toHaveLength(1);
    expect(
      operation === "create_issue"
        ? s.fixture.state.issues.size
        : operation === "add_comment"
          ? s.fixture.state.comments.size
          : s.fixture.state.worklogs.size,
    ).toBe(operation === "create_issue" ? 4 : 1);
  },
);

test("writes from concurrent sessions serialize at the service boundary", async () => {
  const s = await setup();
  let started!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let active = 0;
  let peak = 0;
  let writes = 0;
  const service = new JiraService(
    s.connections,
    s.artifacts,
    async (url, init) => {
      if (init?.method !== "PUT") return s.fetcher(url, init);
      active++;
      peak = Math.max(peak, active);
      writes++;
      if (writes === 1) {
        started();
        await gate;
      }
      try {
        return await s.fetcher(url, init);
      } finally {
        active--;
      }
    },
  );
  const call = (session: string) =>
    service
      .tools(session, () => "run")[1]
      .execute(
        "id",
        {
          request: {
            operation: "update_issue",
            issue: "TEST-1",
            fields: { summary: session },
          },
        },
        new AbortController().signal,
        undefined,
        {} as never,
      );
  const first = call("first");
  await firstStarted;
  const second = call("second");
  release();
  await Promise.all([first, second]);
  expect(peak).toBe(1);
  expect(writes).toBe(2);
  expect(s.fixture.state.issues.get("TEST-1").fields.summary).toBe("second");
});

test("duplicate issue aliases cannot cause two mutations in one batch", async () => {
  const s = await setup();
  const result = (
    await s.call(
      {
        operation: "batch",
        items: [
          { action: "update", issue: "TEST-1", fields: { summary: "A" } },
          { action: "update", issue: "1", fields: { summary: "B" } },
        ],
      },
      true,
    )
  ).data;
  expect(result.status).toBe("invalid_request");
  expect(
    s.fixture.state.requests.filter((r) => r.method === "PUT"),
  ).toHaveLength(0);
});

test("allowed values accept exact project/user identities and reject ambiguous names", async () => {
  const s = await setup(true);
  s.fixture.metadata.project.allowedValues = [
    { id: "1", key: "TEST", name: "Test" },
  ];
  s.fixture.metadata.assignee.allowedValues = [
    { accountId: "712020:fixture", displayName: "Fixture" },
  ];
  s.fixture.metadata.priority.allowedValues = [
    { id: "1", name: "Same" },
    { id: "2", name: "Same" },
  ];
  const result = (
    await s.call(
      {
        operation: "create_issue",
        project: "TEST",
        issueType: "1",
        fields: {
          summary: "Mapped",
          customfield_42: 1,
          assignee: { accountId: "712020:fixture" },
        },
      },
      true,
    )
  ).data;
  expect(result.status).toBe("success");
  expect(
    (
      await s.call(
        {
          operation: "update_issue",
          issue: "TEST-1",
          fields: { priority: { name: "Same" } },
        },
        true,
      )
    ).data.status,
  ).toBe("invalid_field");
});
