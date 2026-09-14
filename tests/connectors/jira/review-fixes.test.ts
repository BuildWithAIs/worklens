import { afterEach, expect, test, vi } from "vitest";
import { JiraService } from "../../../src/main/connectors/jira/service";
import { setup } from "./setup";

afterEach(() => vi.restoreAllMocks());
const completion = {
  operation: "complete_sprint",
  sprint: "5",
  board: "1",
  unfinished: { destination: "sprint", sprint: "6" },
};

test.each([false, true])(
  "sprint closes with unfinished membership intact before moving (cloud=%s)",
  async (cloud) => {
    const s = await setup(cloud);
    const result = await s.call(completion, true);
    expect(result.data.status).toBe("success");
    expect(s.fixture.state.sprintAtClose.get("5")).toEqual([
      "TEST-1",
      "TEST-2",
      "TEST-3",
    ]);
    expect(s.fixture.state.sprintMembership.get("TEST-1")).toBe("6");
    expect(s.fixture.state.sprintMembership.get("TEST-3")).toBe("5");
    expect(result.data.results.map((r: any) => r.step)).toEqual([
      "close",
      "move",
    ]);
  },
);

test.each([false, true])(
  "uncertain close never dispatches a move (cloud=%s)",
  async (cloud) => {
    const s = await setup(cloud);
    s.fixture.state.loseResponsePath = "/rest/agile/1.0/sprint/5";
    const result = await s.call(completion, true);
    expect(result.data.status).toBe("unknown");
    expect(s.fixture.state.sprints.get("5").state).toBe("closed");
    expect(s.fixture.state.sprintMembership.get("TEST-1")).toBe("5");
    expect(
      s.fixture.state.requests.filter(
        (r) => r.method === "POST" && r.path.endsWith("/6/issue"),
      ),
    ).toHaveLength(0);
  },
);

test.each([false, true])(
  "failed transfer preserves closed sprint and exposes recovery targets (cloud=%s)",
  async (cloud) => {
    const s = await setup(cloud);
    s.fixture.state.failPath = "/rest/agile/1.0/sprint/6/issue";
    s.fixture.state.failStatus = 403;
    s.fixture.state.failuresLeft = 1;
    const result = await s.call(completion, true);
    expect(result.data).toMatchObject({
      status: "partial",
      failedStep: "move",
      issues: ["TEST-1", "TEST-2"],
      destination: completion.unfinished,
    });
    expect(s.fixture.state.sprints.get("5").state).toBe("closed");
    expect(result.data.retry).toContain("do not complete");
  },
);

test("invalid destination fails before closing", async () => {
  const s = await setup();
  s.fixture.state.sprints.get("6").state = "closed";
  expect((await s.call(completion, true)).data.status).toBe("invalid_target");
  expect(s.fixture.state.sprints.get("5").state).toBe("active");
});

test("failed result persistence keeps complete long reads and successful writes inline", async () => {
  const s = await setup();
  const text = "readable tail ".repeat(3000);
  s.fixture.state.issues.get("TEST-1").fields.description = text;
  vi.spyOn(s.artifacts, "save").mockRejectedValue(new Error("ENOSPC"));
  const read = await s.call({ operation: "read_issue", issue: "TEST-1" });
  expect(read.data.truncated).toBeUndefined();
  expect(read.data.resultPath).toBeUndefined();
  expect(read.data.data.fields.description).toBe(text);
  expect(read.data.retrievalError).toContain("ENOSPC");
  const request = {
    operation: "add_comment",
    issue: "TEST-1",
    body: { format: "wiki", text },
  };
  const write = await s.call(request, true);
  expect(write.data.status).toBe("success");
  expect(write.data.truncated).toBeUndefined();
  expect(write.data.body).toBe(text);
  await s.call(request, true);
  expect(s.fixture.state.commentCount).toBe(1);
});

test.each([false, true])(
  "project key and numeric ID both create versions (cloud=%s)",
  async (cloud) => {
    const s = await setup(cloud);
    for (const project of ["TEST", "1"]) {
      const result = await s.call(
        { operation: "create_version", project, name: "v1" },
        true,
      );
      expect(result.data.status).toBe("success");
      expect(result.data.projectId).toBe(1);
    }
    const writes = s.fixture.state.requests.filter(
      (r) => r.method === "POST" && r.path.endsWith("/version"),
    );
    expect(writes).toHaveLength(2);
    for (const write of writes)
      expect(write.body).toEqual({ projectId: 1, name: "v1" });
  },
);

test("batch uses narrow preflight reads once, retains preview and timestamp conflict checks", async () => {
  const s = await setup();
  const items = ["TEST-1", "TEST-2", "TEST-3"].map((issue) => ({
    issue,
    action: "update",
    fields: { summary: "Updated" },
  }));
  const preview = (await s.call({ operation: "preview_batch", items })).data
    .preview;
  s.fixture.state.requests.length = 0;
  expect(
    (await s.call({ operation: "batch", items, preview }, true)).data.status,
  ).toBe("success");
  const gets = s.fixture.state.requests.filter((r) => r.method === "GET");
  expect(gets).toHaveLength(6); // three identity reads plus three edit metadata reads
  for (const read of gets.filter((r) => !r.path.endsWith("/editmeta"))) {
    expect(read.query.get("fields")).toBe("updated");
    expect(read.query.has("expand")).toBe(false);
  }
  s.nextRun();
  const conflict = await s.call(
    { operation: "batch", items: [{ ...items[0], expectedUpdated: "stale" }] },
    true,
  );
  expect(conflict.data.results[0].status).toBe("conflict");
  expect(
    s.fixture.state.requests.filter((r) => r.method === "PUT"),
  ).toHaveLength(3);
});

test("50-item batch bounds preflight concurrency and uses a longer deadline", async () => {
  const s = await setup();
  for (let n = 4; n <= 50; n++)
    s.fixture.state.issues.set(`TEST-${n}`, {
      ...s.fixture.state.issues.get("TEST-1"),
      id: String(n),
      key: `TEST-${n}`,
      fields: { ...s.fixture.state.issues.get("TEST-1").fields },
    });
  let active = 0;
  let maximum = 0;
  const fetcher: typeof fetch = async (url, init) => {
    const preflight =
      new URL(String(url)).searchParams.get("fields") === "updated";
    if (preflight) {
      maximum = Math.max(maximum, ++active);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    try {
      return await s.fetcher(url, init);
    } finally {
      if (preflight) active--;
    }
  };
  const service = new JiraService(s.connections, s.artifacts, fetcher);
  const timeout = vi.spyOn(AbortSignal, "timeout");
  const items = Array.from({ length: 50 }, (_, n) => ({
    issue: `TEST-${n + 1}`,
    action: "update",
    fields: { summary: "Batch" },
  }));
  const result = await service
    .tools("session1", () => "large-batch")[1]
    .execute(
      "call",
      { request: { operation: "batch", items } },
      new AbortController().signal,
      undefined,
      {} as never,
    );
  expect(JSON.parse((result.content[0] as { text: string }).text).status).toBe(
    "success",
  );
  expect(maximum).toBe(4);
  expect(timeout).toHaveBeenCalledWith(900_000);
  expect(
    s.fixture.state.requests.filter(
      (r) => r.path.includes("/issue/") && r.method === "GET",
    ),
  ).toHaveLength(100);
  expect(
    s.fixture.state.requests.filter((r) => r.method === "PUT"),
  ).toHaveLength(50);
});
