import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ConfluenceConnections } from "../../../src/main/connectors/confluence/connection";
import { ConfluenceSites } from "../../../src/main/connectors/confluence/sites";
import { ConfluenceService } from "../../../src/main/connectors/confluence/service";
import { confluenceConnector } from "../../../src/main/connectors/confluence";
import { LocalArtifacts } from "../../../src/main/local-artifacts";
import { confluenceFixture } from "./fixture";
import { cleanups, setup, testEncryption } from "./setup";

const settings = (url: string, token: string) => ({
  url,
  deployment: "data-center" as const,
  tokenType: "classic" as const,
  token,
});
async function twoSites() {
  const root = await mkdtemp(join(tmpdir(), "worklens-confluence-sites-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const a = await confluenceFixture();
  const b = await confluenceFixture();
  cleanups.push(a.close, b.close);
  const encryption = testEncryption();
  const path = join(root, "confluence.json");
  const sites = new ConfluenceSites(path, encryption);
  await sites.load();
  const first = await sites.save(settings(a.url, "synthetic-token-a"));
  const second = await sites.save(settings(b.url, "synthetic-token-b"));
  const artifacts = new LocalArtifacts(
    join(root, "artifacts"),
    join(root, "sessions"),
  );
  const service = new ConfluenceService(sites, artifacts);
  return { root, path, a, b, encryption, sites, first, second, service };
}
async function call(
  service: ConfluenceService,
  request: object,
  write = false,
) {
  const tool = service
    .tools("session1", () => "run1")
    .find(
      (item) => item.name === (write ? "confluence_write" : "confluence_read"),
    );
  if (!tool) throw new Error("Tool unavailable");
  const result = (await tool.execute(
    "tool1",
    { request },
    new AbortController().signal,
    undefined,
    {} as never,
  )) as { isError?: boolean; content: { text: string }[] };
  return { isError: result.isError, data: JSON.parse(result.content[0].text) };
}
const requestSchema = (service: ConfluenceService, name: string) =>
  (
    service.tools("s", () => "r").find((tool) => tool.name === name)!
      .parameters as any
  ).properties.request;

test("a single site keeps the existing tool contract and file layout", async () => {
  const f = await setup();
  const schema = requestSchema(f.service, "confluence_read");
  expect(schema.properties).not.toHaveProperty("site");
  expect(schema.required).toEqual(["operation"]);
  expect(f.service.siteInstructions()).toBe("");
  expect(await readdir(f.root)).not.toContain("confluence-sites.json");
  expect((await f.call({ operation: "current_user" })).result.isError).not.toBe(
    true,
  );
});

test("each site uses its own token, cursors and journal scope", async () => {
  const f = await twoSites();
  expect(f.first.id).toBe("primary");
  expect(f.sites.info().map((site) => site.url)).toEqual([f.a.url, f.b.url]);
  const schema = requestSchema(f.service, "confluence_read");
  expect(schema.properties.site.enum).toEqual([f.a.url, f.b.url]);
  expect(schema.required).toContain("site");
  expect(f.service.siteInstructions()).toContain(f.b.url);

  const missing = await call(f.service, { operation: "current_user" });
  expect(missing.isError).toBe(true);
  expect(missing.data.message).toContain("request.site");

  const first = await call(f.service, {
    operation: "search",
    cql: "type=page",
    site: f.a.url,
  });
  expect(first.isError).not.toBe(true);
  const foreign = await call(f.service, {
    operation: "search",
    cql: "type=page",
    site: f.b.url,
    continuation: first.data.continuation,
  });
  expect(foreign.data.status).toBe("invalid_continuation");
  await call(
    f.service,
    { operation: "add_comment", page: "1", content: "hi", site: f.b.url },
    true,
  );
  expect(f.a.state.commentCount).toBe(0);
  expect(f.b.state.commentCount).toBe(1);
  expect(
    f.a.requests.every((r) => r.authorization === "Bearer synthetic-token-a"),
  ).toBe(true);
  expect(
    f.b.requests.every((r) => r.authorization === "Bearer synthetic-token-b"),
  ).toBe(true);
  expect(f.sites.redact("synthetic-token-a synthetic-token-b")).toBe(
    "[redacted] [redacted]",
  );
});

test("duplicate or unverified new sites are never added", async () => {
  const f = await twoSites();
  await expect(
    f.sites.save(settings(f.a.url + "/", "synthetic-token-c")),
  ).rejects.toThrow("已添加");
  const c = await confluenceFixture();
  cleanups.push(c.close);
  c.state.identityStatus = 401;
  await expect(
    f.sites.save(settings(c.url, "synthetic-token-c")),
  ).rejects.toThrow("401");
  expect(f.sites.info()).toHaveLength(2);
  expect(await readdir(join(f.root, "confluence-sites"))).toHaveLength(1);
  // A new site never borrows another site's saved token.
  await expect(
    f.sites.test({ ...settings(f.b.url, ""), token: "" }),
  ).rejects.toThrow("token");
});

test("read-only sites stay readable but are unreachable through confluence_write", async () => {
  const f = await twoSites();
  await f.sites.save({
    ...settings(f.b.url, ""),
    site: f.second.id,
    readOnly: true,
  });
  expect(f.service.names()).toEqual(["confluence_read", "confluence_write"]);
  expect(
    requestSchema(f.service, "confluence_write").properties,
  ).not.toHaveProperty("site");
  const blocked = await call(
    f.service,
    { operation: "add_comment", page: "1", content: "hi", site: f.b.url },
    true,
  );
  expect(blocked.data.status).toBe("permission");
  expect(f.b.state.commentCount).toBe(0);
  const capabilities = await call(f.service, {
    operation: "capabilities",
    site: f.b.url,
  });
  const full = capabilities.data.resultPath
    ? JSON.parse(await readFile(capabilities.data.resultPath, "utf8"))
    : capabilities.data;
  expect(full.write).toEqual([]);
  expect(full.site).toBe(f.b.url);
  expect(JSON.stringify(full.limitations)).toContain("read-only");
  // The only writable site is chosen without a site argument.
  await call(
    f.service,
    { operation: "add_comment", page: "1", content: "hi" },
    true,
  );
  expect(f.a.state.commentCount).toBe(1);
  await f.sites.save({
    ...settings(f.a.url, ""),
    site: "primary",
    readOnly: true,
  });
  expect(f.service.names()).toEqual(["confluence_read"]);
  expect(f.service.tools("s", () => "r").map((tool) => tool.name)).toEqual([
    "confluence_read",
  ]);
  expect(f.service.siteInstructions()).toContain("（只读）");
});

test("restart restores order, read-only state and revisions; the primary file stays v1", async () => {
  const f = await twoSites();
  await f.sites.save({
    ...settings(f.b.url, ""),
    site: f.second.id,
    readOnly: true,
  });
  const revision = f.sites.primary.snapshot().revision;
  const restarted = new ConfluenceSites(f.path, f.encryption);
  await restarted.load();
  expect(
    restarted.info().map(({ id, url, readOnly, configured }) => ({
      id,
      url,
      readOnly,
      configured,
    })),
  ).toEqual([
    { id: "primary", url: f.a.url, readOnly: false, configured: true },
    { id: f.second.id, url: f.b.url, readOnly: true, configured: true },
  ]);
  expect(restarted.primary.snapshot().revision).toBe(revision);
  // Older app versions read only the primary single-site file.
  const legacy = new ConfluenceConnections(f.path, f.encryption);
  await legacy.load();
  expect(legacy.info()).toMatchObject({ url: f.a.url, configured: true });
});

test("removing a site keeps the others and frees the primary slot", async () => {
  const f = await twoSites();
  await f.sites.remove("primary");
  expect(f.sites.info().map((site) => site.id)).toEqual([f.second.id]);
  expect(
    requestSchema(f.service, "confluence_read").properties,
  ).not.toHaveProperty("site");
  expect(
    (await call(f.service, { operation: "current_user" })).isError,
  ).not.toBe(true);
  await f.sites.remove("primary");
  expect(f.sites.info()).toHaveLength(1);
  const again = await f.sites.save(settings(f.a.url, "synthetic-token-a"));
  expect(again.id).toBe("primary");
  await f.sites.remove(f.second.id);
  expect(await readdir(join(f.root, "confluence-sites"))).toEqual([]);
  const connector = confluenceConnector(f.service);
  expect(connector.instructions).not.toContain("多个");
});

test("an unreadable site list is kept for recovery while the primary site loads", async () => {
  const f = await twoSites();
  const index = join(f.root, "confluence-sites.json");
  await writeFile(index, "not json");
  const restarted = new ConfluenceSites(f.path, f.encryption);
  await restarted.load();
  expect(restarted.info().map((site) => site.id)).toEqual(["primary"]);
  expect(await readFile(index + ".invalid", "utf8")).toBe("not json");
});
