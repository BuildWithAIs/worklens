import { ConfluenceService } from "../../../src/main/connectors/confluence/service";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { expect, test, vi } from "vitest";
import {
  ConfluenceConnections,
  normalizeSettings,
} from "../../../src/main/connectors/confluence/connection";
import { applyEdits } from "../../../src/main/connectors/confluence/content";
import { ReadLimiter } from "../../../src/main/connectors/confluence/http";
import {
  readSchema,
  writeSchema,
} from "../../../src/main/connectors/confluence/schema";
import { setup } from "./setup";
import * as storage from "../../../src/main/storage";

test("failed pending journal prevents remote writes and allows a later retry", async () => {
  const f = await setup();
  const request = { operation: "add_comment", page: "1", content: "comment" };
  const original = storage.atomicJson;
  const spy = vi
    .spyOn(storage, "atomicJson")
    .mockImplementation((path, value) => {
      if (basename(dirname(path)) === "operations")
        return Promise.reject(new Error("ENOSPC"));
      return original(path, value);
    });
  try {
    expect((await f.call(request, true)).data.status).toBe("storage_error");
    expect(f.fixture.state.commentCount).toBe(0);
  } finally {
    spy.mockRestore();
  }
  expect((await f.call(request, true)).data.status).toBe("success");
  expect(f.fixture.state.commentCount).toBe(1);
});

test.each([false, true])(
  "final journal failure preserves remote outcome (lost response: %s) and blocks replay",
  async (lostResponse) => {
    const f = await setup();
    f.fixture.state.failWrite = lostResponse;
    const request = { operation: "add_comment", page: "1", content: "comment" };
    const original = storage.atomicJson;
    let journalWrites = 0;
    const spy = vi
      .spyOn(storage, "atomicJson")
      .mockImplementation((path, value) => {
        if (basename(dirname(path)) === "operations" && ++journalWrites > 1)
          return Promise.reject(new Error("ENOSPC"));
        return original(path, value);
      });
    try {
      const out = await f.call(request, true);
      expect(out.data.status).toBe(lostResponse ? "unknown" : "success");
      expect(out.result.isError).toBe(lostResponse);
      if (!lostResponse) {
        expect(out.data.id).toBe("10");
        expect(out.data.journalWarning).toContain("本地完成日志保存失败");
      }
      // The durable pending record still protects retries, including after restart.
      const restarted = new ConfluenceService(f.connections, f.artifacts);
      const replay = await restarted
        .tools("session1", () => "run1")[1]
        .execute(
          "retry",
          { request },
          new AbortController().signal,
          undefined,
          {} as never,
        );
      const data = JSON.parse((replay.content[0] as { text: string }).text);
      expect(data.status).toBe("unknown");
      expect(data.replayed).toBe(true);
      expect(f.fixture.state.commentCount).toBe(1);
    } finally {
      spy.mockRestore();
    }
  },
);
test("queued operations cancel promptly without entering or blocking later work", async () => {
  const limiter = new ReadLimiter(1);
  let release!: () => void;
  const first = limiter.run(
    new AbortController().signal,
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const cancelled = new AbortController();
  const execute = vi.fn();
  const queued = limiter.run(cancelled.signal, execute);
  const assertion = expect(queued).rejects.toThrow("cancel queued");
  cancelled.abort(new Error("cancel queued"));
  await assertion;
  expect(execute).not.toHaveBeenCalled();
  const last = limiter.run(new AbortController().signal, async () => "done");
  release();
  await first;
  expect(await last).toBe("done");
});
test("connection persistence encrypts token, redacts Basic forms and invalidates in-flight snapshots", async () => {
  const f = await setup();
  const before = f.connections.snapshot();
  expect(await readFile(join(f.root, "connection.json"), "utf8")).not.toContain(
    f.input.token,
  );
  const loaded = new ConfluenceConnections(
    join(f.root, "connection.json"),
    f.encryption,
  );
  await loaded.load();
  expect(loaded.snapshot().token).toBe(f.input.token);
  expect(loaded.info()).not.toHaveProperty("token");
  await f.connections.save({ ...f.input, token: "new-synthetic-secret" });
  expect(before.signal.aborted).toBe(true);
  expect(f.connections.redact(f.input.token)).toBe("[redacted]");
  await expect(
    f.connections.candidate({
      ...f.input,
      url: "https://another.example",
      token: "",
    }),
  ).rejects.toThrow("重新填写");
  await f.connections.remove();
  expect(f.connections.info().configured).toBe(false);
});
test("no plaintext fallback when encryption unavailable; damaged credentials remain intact", async () => {
  const f = await setup();
  const path = join(f.root, "blocked.json");
  const connections = new ConfluenceConnections(path, {
    ...f.encryption,
    isEncryptionAvailable: () => false,
  });
  await expect(connections.save(f.input)).rejects.toThrow("安全存储");
  await writeFile(path, "broken");
  await connections.load();
  expect(connections.info().error).toBeTruthy();
  expect(await readFile(path, "utf8")).toBe("broken");
});
test("Cloud requires email and scoped tokens require cloud ID; rejects embedded credentials", () => {
  const input = {
    url: "https://test.atlassian.net",
    deployment: "cloud" as const,
    tokenType: "classic" as const,
  };
  expect(() => normalizeSettings(input)).toThrow("邮箱");
  expect(normalizeSettings({ ...input, email: "test@example.com" }).url).toBe(
    "https://test.atlassian.net/wiki",
  );
  expect(() =>
    normalizeSettings({
      ...input,
      email: "test@example.com",
      tokenType: "scoped",
    }),
  ).toThrow("Cloud ID");
  expect(() =>
    normalizeSettings({ ...input, url: "https://user:pass@wiki.example.com" }),
  ).toThrow("凭据");
});
test("operation contracts reject mixed fields and invalid bounds", () => {
  expect(
    readSchema.safeParse({
      request: { operation: "search", cql: "type=page", page: "1" },
    }).success,
  ).toBe(false);
  expect(
    writeSchema.safeParse({
      request: { operation: "edit_page", page: "1", edits: [] },
    }).success,
  ).toBe(false);
  expect(
    readSchema.safeParse({
      request: { operation: "read_page", page: "1", length: -1 },
    }).success,
  ).toBe(false);
});
test("pagination is bound to query, connection and session; page URLs preserve context paths", async () => {
  const f = await setup();
  const first = await f.call({
    operation: "search",
    cql: "type=page",
    limit: 1,
  });
  expect(first.data.complete).toBe(false);
  const second = await f.call({
    operation: "search",
    cql: "type=page",
    continuation: first.data.continuation,
  });
  expect(second.data.complete).toBe(true);
  expect(
    (
      await f.call({
        operation: "search",
        cql: "type=blogpost",
        continuation: first.data.continuation,
      })
    ).result.isError,
  ).toBe(true);
  const other = await f.service
    .tools("other", () => "r")[0]
    .execute(
      "a",
      {
        request: {
          operation: "search",
          cql: "type=page",
          continuation: first.data.continuation,
        },
      },
      undefined,
      undefined,
      {} as any,
    );
  expect((other as typeof other & { isError?: boolean }).isError).toBe(true);
  const page = await f.call({ operation: "read_page", page: "1" });
  expect(page.data.url).toBe(f.fixture.url + "/display/ENG/Guide");
  expect(
    (
      await f.call({
        operation: "read_page",
        page: "https://evil.example/pages/1",
      })
    ).result.isError,
  ).toBe(true);
});
test("read storage chunks retain versions; exact edits preserve macros and allow empty replacement", async () => {
  const f = await setup();
  const page = await f.call({
    operation: "read_page",
    page: "1",
    representation: "storage",
  });
  expect(page.data.version).toBe(7);
  const update = await f.call(
    {
      operation: "edit_page",
      page: "1",
      expectedVersion: 7,
      edits: [{ find: "Node 22", replace: "Node 24", expectedMatches: 1 }],
    },
    true,
  );
  expect(update.result.isError).toBe(false);
  expect(f.fixture.state.storage).toContain('ac:name="toc"');
  expect(f.fixture.state.storage).toContain("Node 24");
  expect(
    applyEdits("<p>x</p>", [{ find: "x", replace: "", expectedMatches: 1 }]),
  ).toBe("<p></p>");
  expect(() =>
    applyEdits("x x", [{ find: "x", replace: "y", expectedMatches: 1 }]),
  ).toThrow("实际 2");
});
test("concurrent external edits return conflict without retry or overwrite", async () => {
  const f = await setup();
  await f.call({ operation: "read_page", page: "1" });
  f.fixture.state.version++;
  const result = await f.call(
    {
      operation: "replace_page",
      page: "1",
      expectedVersion: 7,
      content: "stale",
    },
    true,
  );
  expect(result.data.status).toBe("conflict");
  expect(f.fixture.requests.filter((r) => r.method === "PUT")).toHaveLength(0);
});
test("configured connections expose and execute writes without an access setting", async () => {
  const f = await setup();
  expect(f.connections.info()).not.toHaveProperty("access");
  expect(f.service.names()).toEqual(["confluence_read", "confluence_write"]);
  expect((await f.call({ operation: "capabilities" })).data).not.toHaveProperty(
    "access",
  );
  const result = await f.call(
    { operation: "add_comment", page: "1", content: "comment" },
    true,
  );
  expect(result.result.isError).toBe(false);
  expect(f.fixture.state.commentCount).toBe(1);
});

test.each(["read", "confirm", "write"])(
  "legacy %s connection migrates without losing credentials or write tools",
  async (access) => {
    const f = await setup();
    const path = join(f.root, "connection.json");
    const saved = JSON.parse(await readFile(path, "utf8"));
    saved.settings.access = access;
    await writeFile(path, JSON.stringify(saved));
    const loaded = new ConfluenceConnections(path, f.encryption);
    await loaded.load();
    expect(loaded.snapshot().token).toBe(f.input.token);
    expect(loaded.info()).not.toHaveProperty("access");
    const migrated = JSON.parse(await readFile(path, "utf8"));
    expect(migrated.encrypted).toBe(saved.encrypted);
    expect(migrated.revision).toBe(saved.revision);
    expect(migrated.settings).not.toHaveProperty("access");
    const service = new ConfluenceService(loaded, f.artifacts);
    expect(service.names()).toEqual(["confluence_read", "confluence_write"]);
    const result = await service
      .tools("migration", () => "run")[1]
      .execute(
        "write",
        {
          request: { operation: "add_comment", page: "1", content: "migrated" },
        },
        undefined,
        undefined,
        {} as any,
      );
    expect((result as { isError?: boolean }).isError).toBe(false);
    expect(f.fixture.state.commentCount).toBe(1);
  },
);

test("lost write response is unknown and identical attempts in a run do not repeat remote mutation", async () => {
  const f = await setup();
  f.fixture.state.failWrite = true;
  const request = { operation: "add_comment", page: "1", content: "comment" };
  expect((await f.call(request, true)).data.status).toBe("unknown");
  const again = await f.call(request, true);
  expect(again.data.status).toBe("unknown");
  expect(again.result.isError).toBe(true);
  expect(f.fixture.state.commentCount).toBe(1);
});
test("completed identical writes in a run are deduplicated", async () => {
  const f = await setup();
  const request = { operation: "add_comment", page: "1", content: "comment" };
  await f.call(request, true);
  expect((await f.call(request, true)).data.replayed).toBe(true);
  expect(f.fixture.state.commentCount).toBe(1);
});
test("connection change invalidates remembered page versions across sessions", async () => {
  const f = await setup();
  await f.call({ operation: "read_page", page: "1" });
  await f.connections.save(f.input);
  const write = await f.call(
    {
      operation: "append_page",
      page: "1",
      expectedVersion: 7,
      content: "hello",
    },
    true,
  );
  expect(write.data.status).toBe("read_required");
});
