import { readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  exportHtml,
  markdownStorage,
  readableStorage,
  storageContent,
} from "../src/main/confluence/content";
import { safeFilename } from "../src/main/local-artifacts";
import { projectMessages } from "../src/main/projection";
import { setup } from "./confluence-setup";
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
