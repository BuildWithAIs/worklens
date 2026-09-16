import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
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
    longPage: false,
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
        return send(state.searchStatus, { detail: { error: "Limit" } });
      return send(200, {
        query: body.query,
        results: [
          {
            title: "Result",
            url: "https://example.com/a",
            content: `about ${body.query}`,
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
  const call = async (name: "web_search" | "web_fetch", params: object) => {
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
  expect(f.service.names()).toEqual(["web_search", "web_fetch"]);

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
  expect(data).toEqual({
    status: "success",
    query: "worklens",
    results: [
      {
        title: "Result",
        url: "https://example.com/a",
        content: "about worklens",
        score: 0.9,
      },
    ],
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

test("web_fetch returns short pages inline and saves long pages as artifacts", async () => {
  const f = await setup();
  await f.connections.save(f.input);
  const short = await f.call("web_fetch", {
    urls: ["https://example.com/doc"],
  });
  expect(short.data.pages).toEqual([
    { url: "https://example.com/doc", content: "# https://example.com/doc" },
  ]);
  expect(short.data.failed).toEqual([
    { url: "https://bad.example", error: "timeout" },
  ]);
  expect(f.fake.state.requests.at(-1)!.body).toMatchObject({
    urls: ["https://example.com/doc"],
    format: "markdown",
  });

  f.fake.state.longPage = true;
  const long = await f.call("web_fetch", {
    urls: ["https://example.com/long"],
  });
  const [page] = long.data.pages;
  expect(page.truncated).toBe(true);
  expect(page.totalLength).toBe(20_000);
  expect(page.content).toHaveLength(12_000);
  expect(page.path).toMatch(/tavily/);
  expect(page.path).toMatch(/example\.com\.md$/);
  expect(await readFile(page.path, "utf8")).toHaveLength(20_000);
});

test("the connector adapter gates tools and the configuration key on the saved connection", async () => {
  const f = await setup();
  const connector = tavilyConnector(f.service);
  await connector.initialize();
  expect(connector.names()).toEqual([]);
  const before = connector.configurationKey();
  await f.connections.save(f.input);
  expect(connector.names()).toEqual(["web_search", "web_fetch"]);
  expect(connector.configurationKey()).not.toBe(before);
  expect(connector.tools("s", () => "r").map((t) => t.name)).toEqual([
    "web_search",
    "web_fetch",
  ]);
  await f.connections.remove();
  expect(connector.names()).toEqual([]);
  expect(f.connections.info()).toEqual({ url: "", configured: false });
});
