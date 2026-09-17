import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { TavilyConnections } from "../../../src/main/connectors/tavily/connection";
import { TavilyService } from "../../../src/main/connectors/tavily/service";
import { tavilyConnector } from "../../../src/main/connectors/tavily";
import { LocalArtifacts } from "../../../src/main/local-artifacts";
import { encryption } from "../github/setup";

const KEY = "tvly-synthetic-secret-key";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fakeTavily() {
  const state = {
    usageStatus: 200,
    searchStatus: 200,
    errorDetail: "Limit",
    longPage: false,
    searchContent: "",
    researchStatus: "pending",
    researchCreateStatus: 201,

    requests: [] as {
      method: string;
      path: string;
      body: any;
      auth?: string;
    }[],
  };
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    state.requests.push({
      method: req.method!,
      path: req.url!,
      body,
      auth: req.headers.authorization,
    });
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    };
    if (req.headers.authorization !== `Bearer ${KEY}`)
      return send(401, { detail: { error: "Unauthorized" } });
    if (req.url === "/usage") {
      if (state.usageStatus !== 200)
        return send(state.usageStatus, { detail: "nope" });
      return send(200, {
        key: { usage: 3, limit: 1000 },
        account: { current_plan: "dev", plan_usage: 3, plan_limit: 1000 },
      });
    }
    if (req.url === "/search") {
      if (state.searchStatus !== 200)
        return send(state.searchStatus, {
          detail: { error: state.errorDetail },
        });
      return send(200, {
        query: body.query,
        results: [
          {
            title: "Result",
            url: "https://example.com/a",
            content: state.searchContent || `about ${body.query}`,
            score: 0.9,
            raw_content: null,
          },
        ],
        response_time: 0.1,
      });
    }
    if (req.url === "/extract")
      return send(200, {
        results: body.urls.map((url: string) => ({
          url,
          raw_content: state.longPage ? "x".repeat(20_000) : `# ${url}`,
        })),
        failed_results: [{ url: "https://bad.example", error: "timeout" }],
      });
    if (req.url === "/research" && req.method === "POST")
      return send(
        state.researchCreateStatus,
        state.researchCreateStatus === 201
          ? { request_id: "research-1", status: "pending" }
          : { detail: state.errorDetail },
      );
    if (req.url === "/research/research-1")
      return send(200, {
        request_id: "research-1",
        status: state.researchStatus,
        content: "研究报告\n" + "资料".repeat(40000) + KEY,
        sources: [{ title: "Source", url: "https://example.com" }],
      });
    send(404, {});
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { port: number };
  cleanups.push(() => new Promise((done) => server.close(() => done(null))));
  return { state, api: `http://127.0.0.1:${port}` };
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "worklens-tavily-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const fake = await fakeTavily();
  const crypto = encryption();
  const connections = new TavilyConnections(
    join(root, "tavily.json"),
    crypto,
    fetch,
  );
  const input = { url: fake.api, token: KEY };
  const artifacts = new LocalArtifacts(join(root, "artifacts"), root);
  const service = new TavilyService(connections, artifacts);
  const call = async (
    name: "web_search" | "web_fetch" | "web_research" | "web_research_status",
    params: object,
  ) => {
    const tool = service.tools("session1").find((t) => t.name === name)!;
    const result = await tool.execute(
      "call1",
      params,
      new AbortController().signal,
      undefined,
      {} as any,
    );
    return {
      result,
      data: JSON.parse((result.content[0] as { text: string }).text),
    };
  };
  return { root, fake, crypto, connections, input, service, call };
}

test("save validates the key through /usage, encrypts it at rest and exposes the tools", async () => {
  const f = await setup();
  expect(f.service.names()).toEqual([]);
  expect(await f.connections.test(f.input)).toBe("Tavily 已连接：dev");
  const saved = await f.connections.save(f.input);
  expect(saved).toEqual({ url: f.fake.api, configured: true, plan: "dev" });
  expect(f.fake.state.requests.map((r) => r.path)).toEqual([
    "/usage",
    "/usage",
  ]);
  const file = await readFile(join(f.root, "tavily.json"), "utf8");
  expect(file).not.toContain(KEY);
  expect(f.service.names()).toEqual([
    "web_search",
    "web_fetch",
    "web_research",
    "web_research_status",
  ]);

  // A fresh instance reloads and re-validates without a second save.
  const reloaded = new TavilyConnections(
    join(f.root, "tavily.json"),
    f.crypto,
    fetch,
  );
  await reloaded.load();
  expect(reloaded.info()).toEqual({
    url: f.fake.api,
    configured: true,
    plan: "dev",
  });
  // Saving again without a token reuses the stored key for the same address…
  expect((await f.connections.save({ url: f.fake.api })).configured).toBe(true);
  // …but a new address needs the key again, and the address is validated.
  await expect(
    f.connections.save({ url: `${f.fake.api}/other` }),
  ).rejects.toThrow("请填写 Tavily API key");
  await expect(
    f.connections.save({ url: "https://user:pw@api.tavily.com", token: KEY }),
  ).rejects.toThrow("不含凭据");
});

test("an invalid key fails to save with a redacted message and keeps tools hidden", async () => {
  const f = await setup();
  await expect(
    f.connections.save({ url: f.fake.api, token: "tvly-wrong" }),
  ).rejects.toThrow(/Tavily 返回 401/);
  expect(f.connections.info()).toMatchObject({
    configured: false,
    error: expect.stringContaining("401"),
  });
  expect(f.service.names()).toEqual([]);
  // Like GitHub, the failed key is retained so the user can retry or disconnect.
  await expect(f.connections.save({ url: f.fake.api })).rejects.toThrow(
    /Tavily 返回 401/,
  );
  await f.connections.remove();
  await expect(f.connections.save({ url: f.fake.api })).rejects.toThrow(
    "请填写 Tavily API key",
  );
});

test("web_search forwards the query with the bearer key and returns trimmed results", async () => {
  const f = await setup();
  await f.connections.save(f.input);
  const { result, data } = await f.call("web_search", {
    query: "worklens",
    max_results: 3,
    topic: "news",
    time_range: "week",
  });
  expect(result).toMatchObject({
    isError: false,
    details: { status: "success" },
  });
  expect(data).toMatchObject({
    status: "success",
    totalResults: 1,
    resultsTruncated: false,
    results: [
      {
        id: 1,
        title: "Result",
        url: "https://example.com/a",
        excerpt: "about worklens",
        excerptTruncated: false,
        score: 0.9,
      },
    ],
  });
  expect(JSON.parse(await readFile(data.rawResultPath, "utf8"))).toMatchObject({
    query: "worklens",
    response_time: 0.1,
  });
  const request = f.fake.state.requests.at(-1)!;
  expect(request.auth).toBe(`Bearer ${KEY}`);
  expect(request.body).toMatchObject({
    query: "worklens",
    max_results: 3,
    topic: "news",
    time_range: "week",
    search_depth: "basic",
  });
});

test.each(["basic", "advanced", "fast", "ultra-fast"])(
  "web_search accepts and forwards search_depth=%s through the agent schema",
  async (search_depth) => {
    const f = await setup();
    await f.connections.save(f.input);
    const tool = f.service
      .tools("session1")
      .find((t) => t.name === "web_search")!;
    const args = validateToolArguments(tool, {
      type: "toolCall",
      id: "search-depth",
      name: tool.name,
      arguments: { query: "specific details", search_depth },
    });
    const { data } = await f.call("web_search", args);
    expect(data.status).toBe("success");
    expect(f.fake.state.requests.at(-1)).toMatchObject({
      path: "/search",
      body: { query: "specific details", search_depth },
    });
  },
);

test.each([undefined, "basic", "advanced"])(
  "web_fetch accepts extract_depth=%s and forwards the selected or default depth",
  async (extract_depth) => {
    const f = await setup();
    await f.connections.save(f.input);
    const tool = f.service
      .tools("session1")
      .find((t) => t.name === "web_fetch")!;
    const args = validateToolArguments(tool, {
      type: "toolCall",
      id: "extract-depth",
      name: tool.name,
      arguments: {
        urls: ["https://example.com/table"],
        ...(extract_depth ? { extract_depth } : {}),
      },
    });
    const { data } = await f.call("web_fetch", args);
    expect(data.status).toBe("success");
    expect(f.fake.state.requests.at(-1)).toMatchObject({
      path: "/extract",
      body: {
        urls: ["https://example.com/table"],
        extract_depth: extract_depth ?? "basic",
        format: "markdown",
      },
    });
  },
);

test("agent schemas reject unsupported depth values before making requests", async () => {
  const f = await setup();
  for (const [name, args] of [
    ["web_search", { query: "x", search_depth: "deep" }],
    ["web_search", { query: "x", search_depth: 1 }],
    ["web_fetch", { urls: ["https://example.com"], extract_depth: "fast" }],
  ] as const) {
    const tool = f.service.tools("session1").find((t) => t.name === name)!;
    expect(() =>
      validateToolArguments(tool, {
        type: "toolCall",
        id: "invalid-depth",
        name,
        arguments: args,
      }),
    ).toThrow();
  }
  expect(f.fake.state.requests).toHaveLength(0);
});

test("web_search maps quota and auth failures to tool statuses and never leaks the key", async () => {
  const f = await setup();
  await f.connections.save(f.input);
  f.fake.state.searchStatus = 432;
  const { result, data } = await f.call("web_search", { query: "x" });
  expect(result).toMatchObject({ isError: true, details: { status: "quota" } });
  expect(data.status).toBe("quota");
  expect(data.message).toContain("Tavily 返回 432");
  expect(JSON.stringify(result)).not.toContain(KEY);
  expect(f.connections.redact(`key=${KEY}`)).toBe("key=[redacted]");
});

test("web_fetch saves every page and returns an index instead of a body preview", async () => {
  const f = await setup();
  await f.connections.save(f.input);
  const short = await f.call("web_fetch", {
    urls: ["https://example.com/doc"],
  });
  const full = JSON.parse(await readFile(short.data.rawResultPath, "utf8"));
  expect(full.results).toEqual([
    {
      url: "https://example.com/doc",
      raw_content: "# https://example.com/doc",
    },
  ]);
  expect(full.failed_results).toEqual([
    { url: "https://bad.example", error: "timeout" },
  ]);
  f.fake.state.longPage = true;
  const urls = Array.from({ length: 5 }, (_, i) => `https://example.com/${i}`);
  const long = await f.call("web_fetch", { urls });
  const output = (long.result.content[0] as { text: string }).text;
  expect(output.length).toBeLessThan(2000);
  expect(Object.keys(long.data)[0]).toBe("resultPath");
  expect(long.data.preview).toBeUndefined();
  expect(long.data.totalResults).toBe(6);
  const saved = JSON.parse(await readFile(long.data.rawResultPath, "utf8"));
  expect(saved.results).toHaveLength(5);
  expect(
    saved.results.every((page: any) => page.raw_content.length === 20000),
  ).toBe(true);
  expect(
    (await readFile(long.data.resultPath, "utf8"))
      .split("\n")
      .every((line) => Buffer.byteLength(line) <= 200),
  ).toBe(true);
});

test("the connector adapter gates tools and the configuration key on the saved connection", async () => {
  const f = await setup();
  const connector = tavilyConnector(f.service);
  await connector.initialize();
  expect(connector.names()).toEqual([]);
  const before = connector.configurationKey();
  await f.connections.save(f.input);
  expect(connector.names()).toEqual([
    "web_search",
    "web_fetch",
    "web_research",
    "web_research_status",
  ]);
  expect(connector.configurationKey()).not.toBe(before);
  expect(connector.tools("s", () => "r").map((t) => t.name)).toEqual([
    "web_search",
    "web_fetch",
    "web_research",
    "web_research_status",
  ]);
  await f.connections.remove();
  expect(connector.names()).toEqual([]);
  expect(f.connections.info()).toEqual({ url: "", configured: false });
});

test("long search results are saved in full and credentials are redacted before storage", async () => {
  const f = await setup();
  await f.connections.save(f.input);
  f.fake.state.searchContent = "汉".repeat(50000) + KEY;
  const result = await f.call("web_search", { query: "long" });
  expect(JSON.stringify(result.data).length).toBeLessThan(2000);
  const saved = await readFile(result.data.rawResultPath, "utf8");
  expect(saved).not.toContain(KEY);
  expect(JSON.parse(saved).results[0].content).toBe(
    "汉".repeat(50000) + "[redacted]",
  );
});

test("storage failures are explicit and do not silently discard fetched content", async () => {
  const f = await setup();
  await f.connections.save(f.input);
  vi.spyOn(f.service.artifacts, "save").mockRejectedValue(
    new Error("disk full"),
  );
  f.fake.state.longPage = true;
  const { result, data } = await f.call("web_fetch", {
    urls: ["https://example.com"],
  });
  expect(result).toMatchObject({ isError: true });
  expect(data.status).toBe("storage_error");
  expect(data.recoverable).toBe(false);
  expect(data.result).toBeUndefined();
  expect(Buffer.byteLength(JSON.stringify(data))).toBeLessThanOrEqual(1800);
  expect(data.resultPath).toBeUndefined();
});

test("research returns a durable handle, resumes after restart, and saves a redacted report once", async () => {
  const f = await setup();
  await f.connections.save(f.input);
  const started = await f.call("web_research", {
    input: "Research a topic",
    model: "mini",
  });
  expect(started.data).toMatchObject({
    status: "accepted",
    handle: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(f.fake.state.requests.at(-1)?.body).toEqual({
    input: "Research a topic",
    model: "mini",
    stream: false,
  });
  await f.call("web_research", { input: "Research a topic", model: "mini" });
  expect(
    f.fake.state.requests.filter((r) => r.path === "/research"),
  ).toHaveLength(1);
  const handle = started.data.handle;
  expect(
    (await f.call("web_research_status", { handle, wait_seconds: 0 })).data
      .status,
  ).toBe("accepted");
  // Restart both connection and service, using only their persisted state.
  const connection = new TavilyConnections(
    join(f.root, "tavily.json"),
    f.crypto,
    fetch,
  );
  await connection.load();
  const resumed = new TavilyService(connection, f.service.artifacts);
  const status = resumed
    .tools("session1")
    .find((tool) => tool.name === "web_research_status")!;
  f.fake.state.researchStatus = "completed";
  const result = await status.execute(
    "status",
    { handle, wait_seconds: 0 },
    new AbortController().signal,
    undefined,
    {} as any,
  );
  const data = JSON.parse((result.content[0] as { text: string }).text);
  expect(data).toMatchObject({
    status: "success",
    researchStatus: "completed",
    handle,
  });
  expect(JSON.stringify(data).length).toBeLessThan(2000);
  const report = await readFile(data.rawResultPath, "utf8");
  expect(report).toContain("研究报告");
  expect(report).toContain("https://example.com");
  expect(report).not.toContain(KEY);
  const before = f.fake.state.requests.length;
  const cached = await status.execute(
    "status-again",
    { handle, wait_seconds: 0 },
    new AbortController().signal,
    undefined,
    {} as any,
  );
  expect(
    JSON.parse((cached.content[0] as { text: string }).text).resultPath,
  ).toBe(data.resultPath);
  expect(f.fake.state.requests).toHaveLength(before);
  const otherSession = resumed
    .tools("session2")
    .find((tool) => tool.name === "web_research_status")!;
  const other = await otherSession.execute(
    "status",
    { handle, wait_seconds: 0 },
    new AbortController().signal,
    undefined,
    {} as any,
  );
  expect(other.details).toEqual({ status: "invalid_handle" });
});

test("uncertain research creation is never retried, including a replay after restart", async () => {
  const f = await setup();
  await f.connections.save(f.input);
  f.fake.state.researchCreateStatus = 500;
  const started = await f.call("web_research", { input: "Research" });
  expect(started.data.status).toBe("submission_unknown");
  const restarted = new TavilyService(f.connections, f.service.artifacts);
  const tool = restarted
    .tools("session1")
    .find((t) => t.name === "web_research")!;
  await tool.execute(
    "call1",
    { input: "Research" },
    new AbortController().signal,
    undefined,
    {} as any,
  );
  expect(
    f.fake.state.requests.filter((r) => r.path === "/research"),
  ).toHaveLength(1);
});

test("completed research retries storage with its handle without creating a second task", async () => {
  const f = await setup();
  await f.connections.save(f.input);
  const {
    data: { handle },
  } = await f.call("web_research", { input: "Research" });
  f.fake.state.researchStatus = "completed";
  const spy = vi
    .spyOn(f.service.artifacts, "save")
    .mockRejectedValueOnce(new Error("disk full"));
  expect(
    (await f.call("web_research_status", { handle, wait_seconds: 0 })).data
      .status,
  ).toBe("storage_error");
  spy.mockRestore();
  expect(
    (await f.call("web_research_status", { handle, wait_seconds: 0 })).data
      .status,
  ).toBe("success");
  expect(
    f.fake.state.requests.filter((r) => r.path === "/research"),
  ).toHaveLength(1);
});

test("polling cancellation preserves the handle; remote failures stay distinct from pending", async () => {
  const f = await setup();
  await f.connections.save(f.input);
  const {
    data: { handle },
  } = await f.call("web_research", { input: "Research" });
  const status = f.service
    .tools("session1")
    .find((tool) => tool.name === "web_research_status")!;
  const controller = new AbortController();
  const waiting = status.execute(
    "status",
    { handle, wait_seconds: 30 },
    controller.signal,
    undefined,
    {} as any,
  );
  await vi.waitFor(() =>
    expect(
      f.fake.state.requests.some((r) => r.path === "/research/research-1"),
    ).toBe(true),
  );
  controller.abort();
  expect((await waiting).details).toEqual({ status: "cancelled" });
  f.fake.state.researchStatus = "failed";
  expect(
    (await f.call("web_research_status", { handle, wait_seconds: 0 })).data
      .status,
  ).toBe("research_failed");
  expect(
    f.fake.state.requests.filter((r) => r.path === "/research"),
  ).toHaveLength(1);
});

test.each(["web_search", "web_research"] as const)(
  "long %s errors are saved and bounded",
  async (name) => {
    const f = await setup();
    await f.connections.save(f.input);
    f.fake.state.searchStatus = 400;
    f.fake.state.researchCreateStatus = 400;
    f.fake.state.errorDetail = "错".repeat(100000) + KEY;
    const { result, data } = await f.call(
      name,
      name === "web_search" ? { query: "q" } : { input: "research" },
    );
    expect(result).toMatchObject({ isError: true });
    expect(data.status).toBe("invalid_request");
    expect(Buffer.byteLength(JSON.stringify(data))).toBeLessThanOrEqual(1800);
    expect(Object.keys(data)[0]).toBe("resultPath");
    const saved = await readFile(data.rawResultPath, "utf8");
    expect(saved).toContain("错".repeat(100000));
    expect(saved).not.toContain(KEY);
    if (name === "web_research") expect(data.handle).toMatch(/^[a-f0-9]{64}$/);
  },
);

test.each([undefined, "topic"])(
  "fetch exposes extraction mode for query %s in preview and saved data",
  async (query) => {
    const f = await setup();
    await f.connections.save(f.input);
    const { data } = await f.call("web_fetch", {
      urls: ["https://example.com"],
      ...(query ? { query } : {}),
    });
    expect(data.contentMode).toBe(query ? "snippets" : "extracted_text");
    expect(data.sourceComplete).toBe(false);
    expect(data.extractionPartial).toBe(true);
    const saved = JSON.parse(await readFile(data.rawResultPath, "utf8"));
    expect(saved.contentMode).toBe(data.contentMode);
    if (query) expect(data.next).toContain("Omit query");
  },
);

test("same credentials preserve research identity across save and failed startup validation", async () => {
  const f = await setup();
  await f.connections.save(f.input);
  const {
    data: { handle },
  } = await f.call("web_research", { input: "research" });
  const revision = f.connections.snapshot().revision;
  await f.connections.save({ url: f.input.url + "/", token: KEY });
  expect(f.connections.snapshot().revision).toBe(revision);
  expect(
    (await f.call("web_research_status", { handle, wait_seconds: 0 })).data
      .status,
  ).toBe("accepted");
  f.fake.state.usageStatus = 401;
  const reloaded = new TavilyConnections(
    join(f.root, "tavily.json"),
    f.crypto,
    fetch,
  );
  await reloaded.load();
  f.fake.state.usageStatus = 200;
  await reloaded.save({ url: f.input.url });
  expect(reloaded.snapshot().revision).toBe(revision);
  const service = new TavilyService(reloaded, f.service.artifacts);
  const tool = service
    .tools("session1")
    .find((t) => t.name === "web_research_status")!;
  const result = await tool.execute(
    "status",
    { handle, wait_seconds: 0 },
    undefined,
    undefined,
    {} as any,
  );
  expect(result.details).toEqual({ status: "accepted" });
  await expect(
    reloaded.save({ url: f.input.url, token: "different" }),
  ).rejects.toThrow();
  const disk = JSON.parse(await readFile(join(f.root, "tavily.json"), "utf8"));
  expect(disk.revision).not.toBe(revision);
});

test("long errors stay bounded when storage fails", async () => {
  const f = await setup();
  await f.connections.save(f.input);
  f.fake.state.searchStatus = 400;
  f.fake.state.errorDetail = "错".repeat(100000) + KEY;
  vi.spyOn(f.service.artifacts, "save").mockRejectedValue(
    new Error("disk full"),
  );
  const { result, data } = await f.call("web_search", { query: "q" });
  expect(result).toMatchObject({ isError: true });
  expect(data).toMatchObject({
    status: "storage_error",
    remoteStatus: "invalid_request",
    recoverable: false,
  });
  expect(data.resultPath).toBeUndefined();
  expect(Buffer.byteLength(JSON.stringify(data))).toBeLessThanOrEqual(1800);
  expect(JSON.stringify(data)).not.toContain(KEY);
});

test("changing the endpoint invalidates old research handles", async () => {
  const f = await setup();
  await f.connections.save(f.input);
  const {
    data: { handle },
  } = await f.call("web_research", { input: "research" });
  const other = await fakeTavily();
  await f.connections.save({ url: other.api, token: KEY });
  expect(
    (await f.call("web_research_status", { handle, wait_seconds: 0 })).data
      .status,
  ).toBe("invalid_handle");
});
