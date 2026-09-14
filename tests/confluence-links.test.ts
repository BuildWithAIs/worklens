import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { readableStorage } from "../src/main/confluence/content";
import { setup } from "./confluence-setup";

const site = "https://example.com/confluence";
const source = `${site}/pages/viewpage.action?pageId=1`;
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
