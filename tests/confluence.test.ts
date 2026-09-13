import { afterEach, expect, test, vi } from "vitest";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  ConfluenceConnections,
  normalizeSettings,
} from "../src/main/confluence/connection";
import {
  ConfluenceHttp,
  ServiceError,
  ReadLimiter,
} from "../src/main/confluence/http";
import { ConfluenceService } from "../src/main/confluence/service";
import { LocalArtifacts, safeFilename } from "../src/main/local-artifacts";
import {
  applyEdits,
  markdownStorage,
  readableStorage,
  storageContent,
  exportHtml,
} from "../src/main/confluence/content";
import { confluenceFixture } from "./confluence-fixture";
import { readSchema, writeSchema } from "../src/main/confluence/schema";
import { projectMessages } from "../src/main/projection";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AgentService } from "../src/main/agent-service";
import { mockServer, fixtureModel } from "./mock-server";
import type { ChatEvent } from "../src/shared/contracts";
const cleanups: (() => Promise<unknown>)[] = [];
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
test("storage validation preserves code examples and export removes unsafe links", () => {
  const code = "```html\n<script>alert(1)</script>\n```";
  expect(storageContent(code, "markdown")).toContain("<![CDATA[<script>");
  expect(() => storageContent("<p>unclosed", "storage")).toThrow();
  expect(() =>
    storageContent("<script>alert(1)</script>", "storage"),
  ).toThrow();
  const html = exportHtml(
    '<a href="java&#x09;script:alert(1)">bad</a><a href="http://[">invalid</a>',
    "Example",
  );
  expect(html).toContain("<a>bad</a><a>invalid</a>");
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
export function testEncryption() {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(value: string) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([cipher.update(value), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
    },
    decryptString(value: Buffer) {
      const cipher = createDecipheriv(
        "aes-256-gcm",
        key,
        value.subarray(0, 12),
      );
      cipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([
        cipher.update(value.subarray(28)),
        cipher.final(),
      ]).toString();
    },
  };
}
async function setup(access: "read" | "confirm" | "write" = "write") {
  const root = await mkdtemp(join(tmpdir(), "worklens-confluence-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const fixture = await confluenceFixture();
  cleanups.push(fixture.close);
  const encryption = testEncryption();
  const connections = new ConfluenceConnections(
    join(root, "connection.json"),
    encryption,
  );
  const input = {
    url: fixture.url,
    deployment: "data-center" as const,
    tokenType: "classic" as const,
    token: "synthetic-secret-123",
    access,
  };
  await connections.save(input);
  const artifacts = new LocalArtifacts(join(root, "artifacts"), root);
  const approval = vi.fn(async () => true);
  const service = new ConfluenceService(connections, artifacts, approval);
  let run = "run1";
  const tools = service.tools("session1", () => run);
  const call = async (
    request: object,
    write = false,
    signal = new AbortController().signal,
  ) => {
    const result = await tools[write ? 1 : 0].execute(
      "tool1",
      { request },
      signal,
      undefined,
      {} as any,
    );
    return {
      result: result as typeof result & { isError?: boolean },
      data: JSON.parse((result.content[0] as { text: string }).text),
    };
  };
  return {
    root,
    fixture,
    connections,
    encryption,
    input,
    artifacts,
    service,
    approval,
    call,
    nextRun: () => {
      run += "x";
    },
  };
}
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
    access: "read" as const,
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
test("approval uses actual prepared changes; denial and connection changes prevent dispatch", async () => {
  const f = await setup("confirm");
  await f.call({ operation: "read_page", page: "1" });
  f.approval.mockResolvedValue(false);
  const request = {
    operation: "append_page",
    page: "1",
    expectedVersion: 7,
    content: "hello",
  };
  expect((await f.call(request, true)).data.status).toBe("cancelled");
  expect(f.approval.mock.calls[0]).toBeTruthy();
  f.approval.mockImplementation(async () => {
    await f.connections.remove();
    return true;
  });
  expect((await f.call(request, true)).result.isError).toBe(true);
  expect(f.fixture.requests.filter((r) => r.method === "PUT")).toHaveLength(0);
});
test("read-only connection blocks write execution even if tool is called directly", async () => {
  const f = await setup("read");
  expect(f.service.names()).toEqual(["confluence_read"]);
  expect(
    (
      await f.call(
        { operation: "add_comment", page: "1", content: "comment" },
        true,
      )
    ).result.isError,
  ).toBe(true);
  expect(f.fixture.state.commentCount).toBe(0);
});
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
test("downloads return registered files; export uses source links and reports partial assets", async () => {
  const f = await setup();
  const downloaded = await f.call({
    operation: "download_attachment",
    attachmentId: "8",
  });
  expect(downloaded.result.isError).toBe(false);
  const artifact = downloaded.data.artifacts[0];
  expect(artifact.name).toBe("diagram.txt");
  expect(artifact.path).toContain("session1");
  expect(await readFile(artifact.path, "utf8")).toBe(
    "fixture attachment bytes",
  );
  expect(await f.artifacts.get(artifact.id)).toEqual(artifact);
  const exported = await f.call({
    operation: "export_page",
    page: "1",
    attachmentIds: ["999"],
  });
  expect(exported.data.status).toBe("partial");
  expect(await readFile(exported.data.artifacts[0].path, "utf8")).toContain(
    f.fixture.url,
  );
});
test("publishing preserves created page and reports failed uploads without retrying page creation", async () => {
  const f = await setup();
  const md = join(f.root, "note.md");
  const asset = join(f.root, "diagram.txt");
  await writeFile(md, "# Meeting\n![diagram](diagram.txt)");
  await writeFile(asset, "image");
  f.fixture.state.failUpload = true;
  const request = {
    operation: "publish_markdown",
    space: "ENG",
    parentId: "1",
    title: "Meeting",
    filePath: md,
    assets: [{ reference: "diagram.txt", filePath: asset }],
  };
  const first = await f.call(request, true);
  expect(first.data.status).toBe("partial");
  expect(first.data.pageId).toBe("1");
  await f.call(request, true);
  expect(f.fixture.state.createCount).toBe(1);
});
test("file saving avoids concurrent collisions and preserves existing exact paths on failure", async () => {
  const f = await setup();
  const [one, two] = await Promise.all([
    f.artifacts.save("s", "a.txt", "one", { directory: f.root }),
    f.artifacts.save("s", "a.txt", "two", { directory: f.root }),
  ]);
  expect(one.path).not.toBe(two.path);
  await expect(
    f.artifacts.save("s", "x", "new", { path: one.path }),
  ).rejects.toThrow("已存在");
  const broken = async function* () {
    yield Buffer.from("partial");
    throw new Error("network gone");
  };
  await expect(
    f.artifacts.save("s", "x", broken(), { path: one.path, overwrite: true }),
  ).rejects.toThrow("network gone");
  expect(await readFile(one.path, "utf8")).toBe("one");
  expect((await readdir(f.root)).filter((p) => p.endsWith(".part"))).toEqual(
    [],
  );
  const linkPath = join(f.root, "link.txt");
  await symlink(one.path, linkPath);
  await expect(
    f.artifacts.save("s", "x", "new", { path: linkPath, overwrite: true }),
  ).rejects.toThrow("符号链接");
  expect(safeFilename("../../CON.txt")).toBe("_CON.txt");
});
test("cancellation removes partial downloads and never commits a file", async () => {
  const f = await setup();
  const controller = new AbortController();
  const stream = async function* () {
    yield Buffer.from("first");
    controller.abort();
    yield Buffer.from("second");
  };
  await expect(
    f.artifacts.save(
      "s",
      "cancelled.txt",
      stream(),
      { directory: f.root },
      controller.signal,
    ),
  ).rejects.toThrow();
  expect(
    (await readdir(f.root)).some(
      (p) => p === "cancelled.txt" || p.endsWith(".part"),
    ),
  ).toBe(false);
});
test("Markdown supports code, tables and selected assets; unknown macros remain visible", () => {
  const storage = markdownStorage(
    "# Title\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```ts\nx < 3\n```\n![image](a.png)",
    { "a.png": "image.png" },
  );
  expect(storage).toContain("<table>");
  expect(storage).toContain("ac:plain-text-body");
  expect(storage).toContain('ri:filename="image.png"');
  expect(() => markdownStorage("![image](missing.png)")).toThrow("尚未上传");
  const read = readableStorage(
    '<ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">ENG-1</ac:parameter></ac:structured-macro>',
    "https://wiki.example",
  );
  expect(read.markdown).toContain("ENG-1");
  expect(read.warnings).toHaveLength(1);
});
test("Cloud scoped requests use the gateway and Basic auth; CDN redirect does not receive credentials", async () => {
  const f = await setup();
  await f.connections.save({
    url: "https://fixture.atlassian.net/wiki",
    deployment: "cloud",
    email: "fixture@example.com",
    token: "scoped-token",
    tokenType: "scoped",
    cloudId: "cloud-123",
    access: "read",
  });
  const calls: { url: string; headers: Headers }[] = [];
  const fetcher = vi.fn(async (url: any, init: any) => {
    calls.push({ url: String(url), headers: new Headers(init.headers) });
    return calls.length === 1
      ? new Response(null, {
          status: 302,
          headers: { location: "https://cdn.example/download?signed=1" },
        })
      : new Response("bytes");
  }) as unknown as typeof fetch;
  const http = new ConfluenceHttp(f.connections.snapshot(), undefined, fetcher);
  await http.download("/rest/api/content/1/child/attachment/8/download");
  expect(calls[0].url).toContain(
    "api.atlassian.com/ex/confluence/cloud-123/wiki/",
  );
  expect(calls[0].headers.get("authorization")).toContain("Basic ");
  expect(calls[1].headers.has("authorization")).toBe(false);
  expect(http.nextPath("/wiki/api/v2/pages?cursor=next")).toBe(
    "/api/v2/pages?cursor=next",
  );
});
test("read retries respect rate-limit guidance; write 503 never automatically retries", async () => {
  const f = await setup();
  let calls = 0;
  const fetcher = vi.fn(async () => {
    calls++;
    return new Response("{}", {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const http = new ConfluenceHttp(f.connections.snapshot(), undefined, fetcher);
  await expect(
    http.json("/rest/api/content", "POST", {}),
  ).rejects.toMatchObject({ code: "unknown" });
  expect(calls).toBe(1);
  const limited = new ConfluenceHttp(
    f.connections.snapshot(),
    undefined,
    async () =>
      new Response("{}", { status: 429, headers: { "retry-after": "120" } }),
  );
  await expect(limited.json("/rest/api/search")).rejects.toBeInstanceOf(
    ServiceError,
  );
});
test("artifact metadata survives message projection", () => {
  const artifacts = [
    { id: "id", name: "test.md", path: "/tmp/test.md", size: 5 },
  ];
  const projected = projectMessages([
    {
      role: "toolResult",
      toolCallId: "a",
      toolName: "confluence_read",
      content: [{ type: "text", text: "done" }],
      details: { artifacts },
    },
  ]);
  expect(projected[0].artifacts).toEqual(artifacts);
});
test("real Pi agent registers and selects Confluence tools, returns structured read results", async () => {
  const f = await setup();
  const model = await mockServer();
  cleanups.push(model.close);
  const runtime = await ModelRuntime.create({ modelsPath: null });
  runtime.registerProvider("worklens-test", {
    name: "Fixture",
    api: "openai-completions",
    baseUrl: model.url,
    apiKey: "synthetic",
    models: [fixtureModel],
  });
  await runtime.refresh({ allowNetwork: false });
  const events: ChatEvent[] = [];
  const agents = new AgentService(
    runtime,
    {
      runtime: f.root,
      sessions: join(f.root, "sessions"),
      userData: join(f.root, "app"),
    },
    (e) => events.push(e),
    (v) => f.connections.redact(v),
    f.service,
  );
  await agents.initialize();
  cleanups.push(() => agents.shutdown());
  const view = await agents.send({
    requestId: "confluence-agent-test",
    text: 'TOOL {"name":"confluence_read","args":{"request":{"operation":"read_page","page":"1"}}}',
    selection: {
      provider: "worklens-test",
      model: "worklens-test",
      thinking: "off",
    },
  });
  await expect
    .poll(
      () =>
        events.some(
          (e) => e.type === "run_end" && e.conversationId === view.id,
        ),
      { timeout: 25000 },
    )
    .toBe(true);
  const final = await agents.open(view.id);
  const tool = final.messages.find((m) => m.toolName === "confluence_read");
  expect(tool?.status, tool?.text).toBe("success");
  expect(tool?.text).toContain("Node 22");
  expect(JSON.stringify(model.requests)).not.toContain(f.input.token);
});

test("Cloud v2 page updates, comments, properties and tasks use deployment-specific payloads", async () => {
  const f = await setup();
  await f.connections.save({
    url: "https://fixture.atlassian.net/wiki",
    deployment: "cloud",
    email: "fixture@example.com",
    token: "cloud-secret",
    tokenType: "classic",
    access: "write",
  });
  const calls: { path: string; method: string; body: any }[] = [];
  let pageVersion = 3;
  let taskStatus = "incomplete";
  const fetcher = (async (url: any, init: any) => {
    const path = new URL(url).pathname;
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method, body });
    const json = (value: any) =>
      new Response(JSON.stringify(value), {
        headers: { "content-type": "application/json" },
      });
    if (path === "/wiki/api/v2/pages/1") {
      if (method === "PUT") {
        expect(body.version.number).toBe(pageVersion + 1);
        expect(body.body.representation).toBe("storage");
        pageVersion++;
      }
      return json({
        id: "1",
        title: "Guide",
        spaceId: "5",
        status: "current",
        version: { number: pageVersion },
        body: { storage: { value: "<p>Node 22</p>" } },
        _links: { webui: "/spaces/ENG/pages/1" },
      });
    }
    if (path === "/wiki/api/v2/footer-comments")
      return json({ id: "90", version: { number: 1 } });
    if (path === "/wiki/api/v2/pages/1/properties")
      return json({
        results: [
          { id: "12", key: "custom", value: "old", version: { number: 1 } },
        ],
      });
    if (path === "/wiki/api/v2/pages/1/properties/12")
      return json({ id: "12", value: body.value, version: body.version });
    if (path === "/wiki/api/v2/tasks/30") {
      if (method === "PUT") taskStatus = body.status;
      return json({
        id: "30",
        status: taskStatus,
        updatedAt: "2026-09-13T00:00:00Z",
      });
    }
    return new Response("{}", {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const service = new ConfluenceService(
    f.connections,
    f.artifacts,
    async () => true,
    fetcher,
  );
  const tools = service.tools("cloud-session", () => "run");
  const call = async (a: object, write = false) => {
    const r = await tools[write ? 1 : 0].execute(
      "t",
      { request: a },
      undefined,
      undefined,
      {} as any,
    );
    return JSON.parse((r.content[0] as { text: string }).text);
  };
  expect((await call({ operation: "read_page", page: "1" })).version).toBe(3);
  expect(
    (
      await call(
        {
          operation: "append_page",
          page: "1",
          expectedVersion: 3,
          content: "More",
        },
        true,
      )
    ).status,
  ).toBe("success");
  expect(
    (
      await call(
        { operation: "add_comment", page: "1", content: "Hello" },
        true,
      )
    ).id,
  ).toBe("90");
  expect(
    calls.find((c) => c.path.endsWith("footer-comments"))?.body,
  ).toMatchObject({ pageId: "1", body: { representation: "storage" } });
  expect(
    (
      await call(
        {
          operation: "set_property",
          page: "1",
          key: "custom",
          value: "new",
          expectedVersion: 1,
        },
        true,
      )
    ).status,
  ).toBe("success");
  expect(
    (
      await call(
        {
          operation: "set_task_status",
          taskId: "30",
          expectedStatus: "incomplete",
          status: "complete",
        },
        true,
      )
    ).status,
  ).toBe("success");
  expect(taskStatus).toBe("complete");
});

test("exact overwrite checks approval-time file identity and does not overwrite files created during download", async () => {
  const f = await setup();
  const path = join(f.root, "existing.txt");
  await writeFile(path, "old");
  f.approval.mockImplementation(async () => {
    await writeFile(path, "changed after preview");
    return true;
  });
  const result = await f.call({
    operation: "download_attachment",
    attachmentId: "8",
    destination: { path, overwrite: true },
  });
  expect(result.result.isError).toBe(true);
  expect(await readFile(path, "utf8")).toBe("changed after preview");
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
