import { expect, test, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { serializeConversation } from "@earendil-works/pi-coding-agent";
import { ConfluenceConnections } from "../src/main/confluence/connection";
import { ConfluenceService } from "../src/main/confluence/service";
import { Continuations } from "../src/main/confluence/continuations";
import {
  discoverySchema,
  describeOperation,
  parseRequest,
} from "../src/main/confluence/discovery";
import { setup } from "./confluence-setup";

function summary(content: { type: "text"; text: string }[]) {
  return serializeConversation([
    {
      role: "toolResult",
      toolCallId: "t",
      toolName: "confluence_read",
      content,
      isError: false,
      timestamp: 0,
    },
  ]);
}

test("Pi compaction retains page offsets and retrieval handle before long content", async () => {
  const f = await setup();
  f.fixture.state.storage = `<p>${"context engineering ".repeat(2000)}</p>`;
  const out = await f.call({ operation: "read_page", page: "1", length: 4000 });
  const compacted = summary(
    out.result.content as { type: "text"; text: string }[],
  );
  expect(compacted).toContain('"nextOffset":4000');
  expect(compacted).toContain('"complete":false');
  expect(compacted).toContain(out.data.resultPath);
  const saved = JSON.parse(await readFile(out.data.resultPath, "utf8"));
  expect(saved.content).toHaveLength(4000);
  expect(saved.version).toBe(7);
});

test("list projection keeps navigation compact and preserves original records in a file", async () => {
  const f = await setup();
  const fetcher = vi.fn(async () =>
    Response.json({
      results: [
        {
          id: "1",
          title: "Guide",
          body: { storage: { value: "x".repeat(20000) } },
          custom: "preserved",
        },
      ],
      _links: { next: "/confluence/rest/api/search?start=2" },
    }),
  );
  const service = new ConfluenceService(f.connections, f.artifacts, fetcher);
  const out = await service
    .tools("session1", () => "run")[0]
    .execute(
      "t",
      { request: { operation: "search", cql: "type=page" } },
      new AbortController().signal,
      undefined,
      {} as never,
    );
  const data = JSON.parse((out.content[0] as { text: string }).text);
  expect(data.items[0].excerpt).toHaveLength(400);
  expect(JSON.stringify(data).length).toBeLessThan(2000);
  const compacted = summary(out.content as { type: "text"; text: string }[]);
  expect(compacted).toContain(data.continuation);
  expect(compacted).toContain(data.resultPath);
  expect(
    JSON.parse(await readFile(data.resultPath, "utf8")).items[0].custom,
  ).toBe("preserved");
});

test("continuations survive connection/service restart and stay session and query bound", async () => {
  const f = await setup();
  const query = { operation: "search", cql: "type=page", limit: 1 };
  const first = await f.call(query);
  const loaded = new ConfluenceConnections(
    join(f.root, "connection.json"),
    f.encryption,
  );
  await loaded.load();
  expect(loaded.snapshot().revision).toBe(f.connections.snapshot().revision);
  const resumed = new ConfluenceService(loaded, f.artifacts);
  const execute = (session: string, request: object) =>
    resumed
      .tools(session, () => "run2")[0]
      .execute(
        "t",
        { request },
        new AbortController().signal,
        undefined,
        {} as never,
      );
  const result = await execute("session1", {
    ...query,
    continuation: first.data.continuation,
  });
  const data = JSON.parse((result.content[0] as { text: string }).text);
  expect(data.items[0].id).toBe("2");
  expect(data.complete).toBe(true);
  const other = await execute("other-session", {
    ...query,
    continuation: first.data.continuation,
  });
  expect(JSON.stringify(other.content)).toContain("invalid_continuation");
  const changed = await execute("session1", {
    ...query,
    cql: "type=blogpost",
    continuation: first.data.continuation,
  });
  expect(JSON.stringify(changed.content)).toContain("invalid_continuation");
  await loaded.save(f.input);
  const revoked = await execute("session1", {
    ...query,
    continuation: first.data.continuation,
  });
  expect(JSON.stringify(revoked.content)).toContain("invalid_continuation");
});

test("expired continuations give restart guidance and never follow a guessed path", async () => {
  const f = await setup();
  const store = new Continuations(f.artifacts.root);
  const owner = { scope: "query", revision: "revision", sessionId: "session" };
  const id = await store.save(owner, "/rest/api/search?start=5");
  const now = Date.now();
  const clock = vi
    .spyOn(Date, "now")
    .mockReturnValue(now + 8 * 24 * 60 * 60 * 1000);
  try {
    await expect(store.resolve(owner, id)).rejects.toThrow("移除 continuation");
  } finally {
    clock.mockRestore();
  }
});

test("final document storage failure returns saved attachments and a document-specific partial result", async () => {
  const f = await setup();
  const save = f.artifacts.save.bind(f.artifacts);
  vi.spyOn(f.artifacts, "save").mockImplementation((...args) =>
    args[1].endsWith(".md")
      ? Promise.reject(new Error("ENOSPC"))
      : save(...args),
  );
  const out = await f.call({
    operation: "export_page",
    page: "1",
    attachmentIds: ["8"],
  });
  expect(out.data.status).toBe("partial");
  expect(out.data.failures).toContainEqual({
    resource: "document",
    code: "storage_error",
    error: "ENOSPC",
  });
  expect(
    (out.result.details as { artifacts: unknown[] }).artifacts,
  ).toHaveLength(1);
  expect(await readFile(out.data.artifacts[0].path, "utf8")).toBe(
    "fixture attachment bytes",
  );
});

test("failure to persist a large mutation result never reports the successful mutation as failed", async () => {
  const f = await setup();
  f.fixture.state.storage = `<p>${"x".repeat(5000)}</p>`;
  await f.call({ operation: "read_page", page: "1" });
  vi.spyOn(f.artifacts, "save").mockRejectedValue(new Error("ENOSPC"));
  const out = await f.call(
    {
      operation: "append_page",
      page: "1",
      expectedVersion: 7,
      content: "Added",
    },
    true,
  );
  expect(out.data.status).toBe("success");
  expect(out.data.retrievalError).toBe("ENOSPC");
  expect(f.fixture.state.version).toBe(8);
});

test("discovery has a fixed small schema budget, filters deployment, and retains strict per-operation validation", async () => {
  const f = await setup();
  const settings = f.connections.info();
  const both = [false, true]
    .map((write) => JSON.stringify(discoverySchema(settings, write)))
    .join("");
  expect(both.length).toBeLessThan(4000);
  expect(both).not.toContain('"archive_page"');
  expect(
    JSON.stringify(discoverySchema({ ...settings, deployment: "cloud" }, true)),
  ).toContain('"archive_page"');
  const contract = describeOperation(settings, "edit_page");
  expect(contract.tool).toBe("confluence_write");
  expect(JSON.stringify(contract.inputSchema)).toContain("expectedMatches");
  expect(() =>
    parseRequest(
      { request: { operation: "edit_page", inventedApproval: true } },
      true,
    ),
  ).toThrow();
  const invalid = await f.call(
    { operation: "edit_page", inventedApproval: true },
    true,
  );
  expect(JSON.stringify(invalid.result.content).length).toBeLessThan(1800);
});

test("legacy encrypted connection migrates once and resumes its new cursor after restart", async () => {
  const f = await setup();
  const path = join(f.root, "connection.json");
  const saved = JSON.parse(await readFile(path, "utf8"));
  delete saved.revision;
  await writeFile(path, JSON.stringify(saved));
  const upgraded = new ConfluenceConnections(path, f.encryption);
  await upgraded.load();
  const migrated = JSON.parse(await readFile(path, "utf8"));
  expect(migrated.revision).toBe(upgraded.snapshot().revision);
  expect(migrated.encrypted).toBe(saved.encrypted);
  expect(await readFile(path, "utf8")).not.toContain(f.input.token);
  const firstService = new ConfluenceService(upgraded, f.artifacts);
  const query = { operation: "search", cql: "type=page", limit: 1 };
  const first = await firstService
    .tools("session1", () => "run1")[0]
    .execute(
      "t",
      { request: query },
      new AbortController().signal,
      undefined,
      {} as never,
    );
  const cursor = JSON.parse(
    (first.content[0] as { text: string }).text,
  ).continuation;
  const restarted = new ConfluenceConnections(path, f.encryption);
  await restarted.load();
  expect(restarted.snapshot().revision).toBe(upgraded.snapshot().revision);
  const service = new ConfluenceService(restarted, f.artifacts);
  const next = await service
    .tools("session1", () => "run2")[0]
    .execute(
      "t",
      { request: { ...query, continuation: cursor } },
      new AbortController().signal,
      undefined,
      {} as never,
    );
  const result = JSON.parse((next.content[0] as { text: string }).text);
  expect(result.items[0].id).toBe("2");
  expect(result.complete).toBe(true);
});
