import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { readableStorage } from "../../../src/main/connectors/confluence/content";
import { ConfluenceService } from "../../../src/main/connectors/confluence/service";
import { ConfluenceHttp } from "../../../src/main/connectors/confluence/http";
import { citationUrl } from "../../../src/main/connectors/confluence/list-results";
import { projectMessages } from "../../../src/main/projection";
import { messageOutputPaths } from "../../../src/shared/file-references";
import { setup } from "./setup";

const site = "https://example.com/confluence";
const source = `${site}/pages/viewpage.action?pageId=1`;

test("search returns remote citation URLs without advertising retrieval files as artifacts", async () => {
  const f = await setup();
  const items = [
    {
      content: { id: "11", type: "page", title: "Overview" },
      url: "/display/ENG/Overview",
    },
    {
      content: {
        id: "12",
        type: "page",
        title: "Guide",
        _links: { webui: "/confluence/display/ENG/Guide" },
      },
    },
    { content: { id: "13", type: "blogpost", title: "News" } },
    {
      id: "14",
      type: "page",
      title: "Reference",
      _links: { webui: "display/ENG/Reference" },
    },
    {
      content: { id: "15", type: "page", title: "Absolute" },
      url: `${f.fixture.url}/pages/viewpage.action?pageId=15#notes`,
    },
    {
      content: { id: "16", type: "attachment", title: "report.pdf" },
      url: "/download/attachments/11/report.pdf",
    },
    { id: "17", type: "global", name: "Engineering" },
  ];
  const fetcher = vi.fn(async () =>
    Response.json({ results: items, _links: {} }),
  );
  const service = new ConfluenceService(f.sites, f.artifacts, fetcher);
  const out = await service.execute(
    false,
    { request: { operation: "search", cql: "type=page" } },
    "session1",
    "run1",
  );
  const data = JSON.parse((out.content[0] as { text: string }).text);
  expect(data.status).toBe("success");
  expect(data.items.map((item: { url?: string }) => item.url)).toEqual([
    `${f.fixture.url}/display/ENG/Overview`,
    `${f.fixture.url}/display/ENG/Guide`,
    `${f.fixture.url}/pages/viewpage.action?pageId=13`,
    `${f.fixture.url}/display/ENG/Reference`,
    `${f.fixture.url}/pages/viewpage.action?pageId=15#notes`,
    `${f.fixture.url}/download/attachments/11/report.pdf`,
    undefined,
  ]);
  expect(out.details).toMatchObject({ artifacts: [] });
  const messages = projectMessages([
    {
      role: "toolResult",
      toolName: "confluence_read",
      toolCallId: "search",
      ...out,
    },
  ]);
  expect(messages[0].artifacts).toEqual([]);
  expect(messageOutputPaths(messages)).toEqual([]);
  const saved = JSON.parse(await readFile(data.resultPath, "utf8"));
  expect(saved.items).toEqual(
    items.map((item, index) => ({ ...item, url: data.items[index].url })),
  );
});

test.each(["data-center", "cloud"] as const)(
  "%s PDF metadata has remote URLs in search, lists and reads without downloading the PDF",
  async (deployment) => {
    const f = await setup();
    if (deployment === "cloud")
      await f.connections.save({
        url: "https://fixture.atlassian.net/wiki",
        deployment,
        tokenType: "scoped",
        token: "synthetic-scoped-token",
        email: "fixture@example.com",
        cloudId: "cloud-123",
      });
    const base = f.connections.snapshot().settings.url;
    const download = "/download/attachments/11/report.pdf?version=2";
    const attachment = {
      id: "21",
      type: "attachment",
      title: "report.pdf",
      ...(deployment === "cloud"
        ? { downloadLink: "/wiki" + download, fileSize: 4096 }
        : { _links: { download }, extensions: { fileSize: 4096 } }),
    };
    const fetcher = vi.fn(async (url: Parameters<typeof fetch>[0]) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/search"))
        return Response.json({
          results: [{ content: attachment }],
          _links: {},
        });
      if (path.endsWith("/attachments") || path.endsWith("/child/attachment"))
        return Response.json({ results: [attachment], _links: {} });
      return Response.json(attachment);
    });
    const service = new ConfluenceService(f.sites, f.artifacts, fetcher);
    const save = vi.spyOn(f.artifacts, "save");
    for (const request of [
      { operation: "search", cql: "type=attachment" },
      { operation: "list_attachments", page: "11" },
      { operation: "read_attachment", attachmentId: "21" },
    ]) {
      const result = await service.execute(
        false,
        { request },
        "session1",
        "run1",
      );
      const data = JSON.parse((result.content[0] as { text: string }).text);
      expect(data.status).toBe("success");
      expect(data.items?.[0].url ?? data.url).toBe(base + download);
      expect(result.details).toMatchObject({ artifacts: [] });
      if (data.resultPath) {
        const cached = JSON.parse(await readFile(data.resultPath, "utf8"));
        expect(cached.items[0].url).toBe(base + download);
        expect(cached.items[0].content ?? cached.items[0]).toMatchObject(
          attachment,
        );
      }
    }
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(
      save.mock.calls.every((call) => call[1] === "confluence-result.json"),
    ).toBe(true);

    // Disk failure must not replace usable remote citations with filenames.
    save.mockRejectedValue(new Error("ENOSPC"));
    const result = await service.execute(
      false,
      { request: { operation: "search", cql: "type=attachment" } },
      "session1",
      "run2",
    );
    const data = JSON.parse((result.content[0] as { text: string }).text);
    expect(data.itemsSummarized).toBe(false);
    expect(data.items[0].url).toBe(base + download);
    expect(result.details).toMatchObject({ artifacts: [] });
  },
);

test("invalid attachment URLs do not become local targets or discard valid alternatives", async () => {
  const f = await setup();
  const http = new ConfluenceHttp(f.connections.snapshot());
  for (const url of [
    "javascript:alert(1)",
    "file:///tmp/report.pdf",
    "https://[",
    42,
  ]) {
    expect(
      citationUrl({ type: "attachment", id: "21", url }, http),
    ).toBeUndefined();
    expect(
      citationUrl(
        {
          type: "attachment",
          id: "21",
          url,
          _links: { download: "/download/attachments/11/report.pdf" },
        },
        http,
      ),
    ).toBe(`${f.fixture.url}/download/attachments/11/report.pdf`);
  }
});

test("Cloud attachment browser links take precedence over download links", async () => {
  const f = await setup();
  const http = new ConfluenceHttp(f.connections.snapshot());
  const webuiLink =
    "/pages/viewpageattachments.action?pageId=11&preview=%2F11%2F21%2Freport.pdf";
  expect(
    citationUrl(
      {
        id: "21",
        webuiLink,
        downloadLink: "/download/attachments/11/report.pdf",
      },
      http,
    ),
  ).toBe(f.fixture.url + webuiLink);
});

test("table exports rewrite exact attachment names without consuming HTML or similarly named links", async () => {
  const f = await setup();
  f.fixture.state.attachmentTitle = "report.pdf";
  f.fixture.state.storage =
    '<table><tbody><tr><td><ac:link><ri:attachment ri:filename="report.pdf"/><ac:plain-text-link-body><![CDATA[Picked]]></ac:plain-text-link-body></ac:link></td><td><ac:link><ri:attachment ri:filename="report.pdf.zip"/><ac:plain-text-link-body><![CDATA[Other]]></ac:plain-text-link-body></ac:link></td></tr></tbody></table>';
  const out = await f.call({
    operation: "export_page",
    page: "1",
    format: "html",
    attachmentIds: ["8"],
  });
  expect(out.data.status).toBe("success");
  const html = await readFile(out.data.artifacts[0].path, "utf8");
  expect(html).toMatch(/<a href="assets-[a-f0-9]+\/report.pdf">Picked<\/a>/);
  expect(html).toContain(
    `<a href="${f.fixture.url}/display/ENG/Guide">Other</a>`,
  );
  expect(html).toContain("</td></tr>");
});
test("internal links preserve page IDs, title-only references, spaces, anchors and labels", () => {
  const out = readableStorage(
    `<p><ac:link ac:anchor="Install"><ri:page ri:content-id="2"/><ac:plain-text-link-body><![CDATA[Guide]]></ac:plain-text-link-body></ac:link></p>
    <p><ac:link ac:anchor="Steps"><ri:page ri:content-title="Deploy" ri:space-key="ENG"/><ac:link-body><strong>Deployment guide</strong></ac:link-body></ac:link></p>
    <p><ac:link ac:anchor="Local"><ac:plain-text-link-body><![CDATA[Jump]]></ac:plain-text-link-body></ac:link></p>`,
    source,
    site,
  );
  expect(out.markdown).toContain(
    `[Guide](${site}/pages/viewpage.action?pageId=2#Install)`,
  );
  expect(out.markdown).toContain("Deployment guide");
  expect(out.markdown).toContain('"title":"Deploy"');
  expect(out.markdown).toContain('"space":"ENG"');
  expect(out.markdown).toContain('"anchor":"Steps"');
  expect(out.markdown).toContain(`[Jump](${source}#Local)`);
  expect(out.warnings).toHaveLength(1);
});

test("unknown and cross-page references remain recoverable instead of linking the wrong local attachment", () => {
  const crossPage =
    '<ac:link><ri:attachment ri:filename="report.pdf"><ri:page ri:content-title="Other"/></ri:attachment></ac:link>';
  const unknown = '<ac:link><ri:custom ri:key="target"/></ac:link>';
  const unsafe = '<ac:link><ri:url ri:value="javascript:alert(1)"/></ac:link>';
  const out = readableStorage(crossPage + unknown + unsafe, source, site);
  expect(out.markdown).toContain(crossPage);
  expect(out.markdown).toContain(unknown);
  expect(out.markdown).toContain(unsafe);
  expect(out.markdown).not.toContain("](attachment:");
  expect(out.warnings.length).toBeGreaterThan(0);
});

test("published attachment links survive reading and Markdown/HTML export with selected files", async () => {
  const f = await setup();
  const document = join(f.root, "note.md");
  const asset = join(f.root, "report (v1).pdf");
  f.fixture.state.attachmentTitle = "report (v1).pdf";
  await writeFile(document, "[Download report](asset.pdf)");
  await writeFile(asset, "test attachment");
  const published = await f.call(
    {
      operation: "publish_markdown",
      space: "ENG",
      parentId: "1",
      title: "Note",
      filePath: document,
      assets: [{ reference: "asset.pdf", filePath: asset }],
    },
    true,
  );
  expect(published.data.status).toBe("success");
  const read = await f.call({ operation: "read_page", page: "1" });
  expect(read.data.content).toContain(
    "[Download report](attachment:report%20%28v1%29.pdf)",
  );
  for (const format of ["markdown", "html"]) {
    const exported = await f.call({
      operation: "export_page",
      page: "1",
      format,
      attachmentIds: ["8"],
    });
    expect(exported.data.status).toBe("success");
    const text = await readFile(exported.data.artifacts[0].path, "utf8");
    expect(text).toContain("Download report");
    expect(text).toMatch(/assets-[a-f0-9]+\/report%20%28v1%29\.pdf/);
    expect(text).not.toContain("attachment:");
  }
  const withoutAssets = await f.call({ operation: "export_page", page: "1" });
  expect(
    await readFile(withoutAssets.data.artifacts[0].path, "utf8"),
  ).toContain(`[Download report](${f.fixture.url}/display/ENG/Guide)`);
});
