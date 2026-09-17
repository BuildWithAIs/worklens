import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import { createReadTool } from "@earendil-works/pi-coding-agent";
import { LocalArtifacts } from "../../../src/main/local-artifacts";
import { TavilyConnections } from "../../../src/main/connectors/tavily/connection";
import { toolResult } from "../../../src/main/connectors/tavily/results";
import { encryption } from "../github/setup";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "wl-index-"));
  roots.push(root);
  const connections = new TavilyConnections(
    join(root, "connection.json"),
    encryption(),
  );
  const artifacts = new LocalArtifacts(join(root, "artifacts"), root);
  const call = async (
    operation: string,
    value: object,
    session = "s1",
    signal?: AbortSignal,
  ) => {
    const result = await toolResult(
      connections,
      artifacts,
      session,
      operation,
      { status: "success", ...value },
      signal,
    );
    const text = (result.content[0] as { text: string }).text;
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1800);
    return JSON.parse(text);
  };
  const indexItems = async (data: any) => {
    const text = await readFile(data.rawIndexPath ?? data.resultPath, "utf8");
    // The index consists of a header and independent JSON objects, separated by blank lines.
    return text
      .split("\n\n")
      .slice(1)
      .map((block) => JSON.parse(block));
  };
  return { root, connections, artifacts, call, indexItems };
}

test("search produces ordered excerpts and a resumable index without losing original data", async () => {
  const f = await setup();
  const results = Array.from({ length: 20 }, (_, i) => ({
    title: `Source ${i + 1}`,
    url: `https://source-${i + 1}.example/article`,
    content: `Evidence ${i + 1}. ` + "中文🙂\n\t".repeat(500),
    score: 1 - i / 100,
    extra: "preserved only in raw response",
  }));
  const data = await f.call("web_search", { query: "research topic", results });
  expect(data.totalResults).toBe(20);
  expect(data.results.length).toBeGreaterThanOrEqual(2);
  expect(data.results.length).toBeLessThan(20);
  expect(data.resultsTruncated).toBe(true);
  expect(data.preview).toBeUndefined();
  const index = await f.indexItems(data);
  expect(index.map((item: any) => item.url)).toEqual(
    results.map((item) => item.url),
  );
  for (const [i, item] of index.entries()) {
    expect(item.id).toBe(i + 1);
    expect(item.score).toBe(results[i].score);
    expect(item.excerptTruncated).toBe(true);
    expect(item.excerpt).not.toMatch(/[\n\t\uFFFD]/);
    expect(Buffer.byteLength(item.excerpt)).toBeLessThanOrEqual(240);
  }
  const continuation = await createReadTool(f.root).execute("read", {
    path: data.resultPath,
    offset: data.nextOffset,
    limit: 40,
  });
  expect((continuation.content[0] as any).text).toContain(
    `"id": ${data.results.length + 1},`,
  );
  expect(
    JSON.parse(await readFile(data.rawResultPath, "utf8")).results,
  ).toEqual(results);
  expect((await readFile(data.resultPath, "utf8")).length).toBeLessThan(20000);
});

test("empty and small result sets expose exact counts and no unnecessary continuation", async () => {
  const f = await setup();
  for (const results of [
    [],
    [
      {
        title: "Title",
        url: "https://example.com",
        content: "Short text",
        score: 0.7,
      },
    ],
  ]) {
    const data = await f.call("web_search", { results });
    expect(data.totalResults).toBe(results.length);
    expect(data.results).toHaveLength(results.length);
    expect(data.resultsTruncated).toBe(false);
    expect(data.nextOffset).toBeUndefined();
    if (results.length) expect(data.results[0].excerptTruncated).toBe(false);
  }
});

test("escaped Unicode and long URLs respect the byte budget without truncating URLs", async () => {
  const f = await setup();
  const url = "https://example.com/" + "路径".repeat(400);
  const results = [
    { title: '标题🙂"\\'.repeat(80), url, content: '内容🙂"\\'.repeat(100) },
  ];
  const data = await f.call("web_search", { results });
  expect(data.results).toEqual([]);
  expect(data.resultsTruncated).toBe(true);
  const [item] = await f.indexItems(data);
  expect(item.url).toBe(url);
  expect(item.titleTruncated).toBe(true);
  const lines = (await readFile(data.resultPath, "utf8")).split("\n");
  expect(lines.every((line) => Buffer.byteLength(line) <= 200)).toBe(true);
  expect(lines[data.nextOffset - 1]).toBe("{");
});

test("five large pages have independent readable Markdown and failed URLs have no false content path", async () => {
  const f = await setup();
  const results = Array.from({ length: 5 }, (_, i) => ({
    url: `https://page-${i + 1}.example`,
    raw_content: `# Page ${i + 1}\n\n` + "正文🙂".repeat(10000),
  }));
  const data = await f.call("web_fetch", {
    results,
    failed_results: [{ url: "https://failed.example", error: "timeout" }],
    contentMode: "extracted_text",
    sourceComplete: false,
    extractionPartial: true,
  });
  expect(data.totalResults).toBe(6);
  const index = await f.indexItems(data);
  expect(index).toHaveLength(6);
  expect(index[5]).toEqual({
    id: 6,
    url: "https://failed.example",
    status: "failed",
    error: "timeout",
  });
  expect((await readFile(data.resultPath, "utf8")).length).toBeLessThan(10000);
  expect(data.totalLines).toBeLessThan(150);
  for (let i = 0; i < 5; i++) {
    expect(await readFile(index[i].rawResultPath, "utf8")).toBe(
      results[i].raw_content,
    );
    expect(
      (await readFile(index[i].resultPath, "utf8")).split("\n"),
    ).toHaveLength(index[i].totalLines);
  }
  const page = await createReadTool(f.root).execute("read", {
    path: index[4].resultPath,
    offset: 1,
    limit: 40,
  });
  const text = (page.content[0] as any).text;
  expect(text).toContain("# Page 5\n\n");
  expect(text).not.toContain("# Page 1");
  expect(text).toContain("offset=41");
  expect(Buffer.byteLength(text)).toBeLessThan(8500);
  expect(
    JSON.parse(await readFile(data.rawResultPath, "utf8")).results,
  ).toEqual(results);
});

test("redaction happens before excerpts are cut and parallel calls keep distinct indexes", async () => {
  const f = await setup();
  const secret = "synthetic-secret-that-crosses-the-excerpt-boundary";
  vi.spyOn(f.connections, "redact").mockImplementation((text) =>
    text.split(secret).join("[redacted]"),
  );
  const results = [
    {
      title: "Source",
      url: "https://example.com",
      content: "x".repeat(235) + secret,
    },
  ];
  const data = await Promise.all([
    f.call("web_search", { results }),
    f.call("web_search", { results }),
    f.call("web_search", { results }, "s2"),
  ]);
  expect(new Set(data.map((item) => item.resultPath)).size).toBe(3);
  expect(data[2].resultPath).toContain("s2");
  for (const item of data) {
    expect(JSON.stringify(item)).not.toContain("synth");
    expect(await readFile(item.rawResultPath, "utf8")).not.toContain(secret);
    expect(await readFile(item.resultPath, "utf8")).not.toContain("synth");
  }
});

test("index or page storage failure stays bounded and cancellation returns no false index", async () => {
  const f = await setup();
  const save = f.artifacts.save.bind(f.artifacts);
  vi.spyOn(f.artifacts, "save").mockImplementation(async (...args) => {
    if (args[1].includes("index")) throw new Error("disk full");
    return save(...args);
  });
  const data = await f.call("web_search", {
    results: [{ content: "x".repeat(10000) }],
  });
  expect(data).toMatchObject({ status: "storage_error", recoverable: false });
  expect(data.resultPath).toBeUndefined();
  const controller = new AbortController();
  controller.abort();
  const cancelled = await f.call(
    "web_fetch",
    { results: [{ url: "https://example.com", raw_content: "text" }] },
    "s1",
    controller.signal,
  );
  expect(cancelled.status).toBe("cancelled");
  expect(cancelled.resultPath).toBeUndefined();
});
