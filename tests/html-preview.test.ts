import { test, expect } from "vitest";
import { mkdtemp, writeFile, mkdir, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readHtmlPreview, htmlActionFile } from "../src/main/html-preview";

test("HTML preview reads referenced files and rejects unauthorized paths and oversized files", async () => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "html-preview-")));
  const root = join(temp, "runtime");
  await mkdir(root);
  const file = join(root, "page.html");
  const messages = (path: string) => [{ id: "a", role: "assistant" as const, text: "`" + path + "`" }];
  try {
    await writeFile(file, "<html>hello</html>");
    expect(await readHtmlPreview(root, file, messages(file))).toBe("<html>hello</html>");
    await expect(readHtmlPreview(root, file, [])).rejects.toThrow();
    await expect(readHtmlPreview(root, file, [{ id: "u", role: "user", text: "`" + file + "`" }])).rejects.toThrow();
    const outside = join(temp, "outside.html");
    await writeFile(outside, "private");
    await expect(readHtmlPreview(root, outside, messages(outside))).rejects.toThrow();
    const link = join(root, "link.html");
    await symlink(outside, link);
    await expect(readHtmlPreview(root, link, messages(link))).rejects.toThrow();
    const missing = join(root, "missing.html");
    await expect(readHtmlPreview(root, missing, messages(missing))).rejects.toThrow();
    await writeFile(file, "x".repeat(2 * 1024 * 1024 + 1));
    await expect(readHtmlPreview(root, file, messages(file))).rejects.toThrow();
  } finally { await rm(temp, { recursive: true, force: true }); }
});


test("native actions only use validated local files or source present in the conversation", async () => {
  const code = "<!doctype html><html><body>export</body></html>";
  await expect(htmlActionFile("/unused", { code }, [])).rejects.toThrow("unavailable");
  const file = await htmlActionFile("/unused", { code }, [{ id: "a", role: "assistant", text: code }]);
  try {
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(file, "utf8")).toBe(code);
    await expect(htmlActionFile("/unused", { path: file, code }, [])).rejects.toThrow("Invalid");
  } finally { await rm(dirname(file), { recursive: true, force: true }); }
});
