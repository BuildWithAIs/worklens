import { afterEach, expect, test } from "vitest";
import {
  mkdtemp,
  mkdir,
  realpath,
  writeFile,
  symlink,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  inspectConversationFile,
  previewConversationFile,
  type FileContext,
} from "../src/main/conversation-files";
import {
  isLocalReference,
  localReferences,
} from "../src/shared/file-references";

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "conversation-files-")),
  );
  temps.push(root);
  const cwd = join(root, "session", "workspace");
  await mkdir(cwd, { recursive: true });
  const context: FileContext = {
    cwd,
    roots: [join(root, "session")],
    messages: [],
  };
  const mention = (path: string) =>
    context.messages.push({
      id: "a",
      role: "assistant",
      text: `File: \`${path}\``,
    });
  return { root, cwd, context, mention };
}

test("relative paths resolve to the actual session workspace, including workspace-prefixed output", async () => {
  const f = await fixture();
  const path = join(f.cwd, "desktop.png");
  const content = Buffer.from("iVBORw0KGgo=", "base64");
  await writeFile(path, content);
  for (const ref of ["workspace/desktop.png", "./desktop.png", "desktop.png"]) {
    f.mention(ref);
    const file = await inspectConversationFile(f.context, ref);
    expect(file).toEqual({ path, kind: "image" });
    expect((await previewConversationFile(file)).content).toBe(
      `data:image/png;base64,${content.toString("base64")}`,
    );
  }
  await expect(
    inspectConversationFile(f.context, "unmentioned.txt"),
  ).rejects.toThrow("Unreferenced");
});

test("external files require specific task evidence, not merely an assistant mention or a parent directory", async () => {
  const f = await fixture();
  const external = join(f.root, "My draft.html");
  await writeFile(external, "<html>draft</html>");
  f.mention(external);
  expect((await inspectConversationFile(f.context, external)).issue).toBe(
    "unassociated",
  );
  f.context.messages.push({ id: "u", role: "user", text: `Use \`${f.root}\`` });
  expect((await inspectConversationFile(f.context, external)).issue).toBe(
    "unassociated",
  );
  f.context.messages.push({
    id: "edit",
    role: "tool",
    toolName: "edit",
    targetPath: external,
    status: "error",
    text: "Failed",
  });
  expect((await inspectConversationFile(f.context, external)).issue).toBe(
    "unassociated",
  );
  f.context.messages.at(-1)!.status = "success";
  const file = await inspectConversationFile(f.context, external);
  expect(file).toEqual({ path: external, kind: "html" });
  expect((await previewConversationFile(file)).content).toBe(
    "<html>draft</html>",
  );
});

test("user-selected and shell-produced external files can be opened without granting neighboring files", async () => {
  const f = await fixture();
  const external = join(f.root, "report.pdf");
  await writeFile(external, "pdf");
  f.mention(external);
  f.context.messages.push({
    id: "shell",
    role: "tool",
    toolName: "bash",
    status: "success",
    args: JSON.stringify({ command: `render --output '${external}'` }),
    text: "Done",
  });
  expect(await inspectConversationFile(f.context, external)).toEqual({
    path: external,
    kind: "file",
  });
  const other = join(f.root, "other.txt");
  await writeFile(other, "other");
  f.mention(other);
  expect((await inspectConversationFile(f.context, other)).issue).toBe(
    "unassociated",
  );
  f.context.messages.push({ id: "u", role: "user", text: `Read \`${other}\`` });
  expect(
    (await inspectConversationFile(f.context, other)).issue,
  ).toBeUndefined();
});

test("oversized previews do not disable native actions; deleted files and escaping symlinks have distinct states", async () => {
  const f = await fixture();
  const path = join(f.cwd, "large.html");
  await writeFile(path, "x".repeat(2 * 1024 * 1024 + 1));
  f.mention(path);
  const file = await inspectConversationFile(f.context, path);
  expect(file.issue).toBeUndefined();
  expect((await previewConversationFile(file)).issue).toBe("tooLarge");
  expect(
    (await inspectConversationFile(f.context, path)).issue,
  ).toBeUndefined();
  await rm(path);
  expect((await inspectConversationFile(f.context, path)).issue).toBe(
    "missing",
  );
  const secret = join(f.root, "secret.html");
  await writeFile(secret, "secret");
  await symlink(secret, path);
  expect((await inspectConversationFile(f.context, path)).issue).toBe(
    "unassociated",
  );
  f.mention(f.cwd);
  expect((await inspectConversationFile(f.context, f.cwd)).kind).toBe(
    "directory",
  );
});

test("reference parsing keeps URLs distinct and supports spaces, Unicode and Windows paths", () => {
  for (const url of [
    "https://example.com/a.png",
    "http://example.com",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "//example.com/a.png",
  ])
    expect(isLocalReference(url)).toBe(false);
  expect(isLocalReference("settings.theme")).toBe(false);
  expect(localReferences("`/tmp/literal%20name.png`")).toContain(
    "/tmp/literal%20name.png",
  );
  for (const path of [
    "C:\\Users\\Leo\\image.png",
    "/Users/Leo/设计 图.png",
    "workspace/a.png",
    "./report.pdf",
  ])
    expect(isLocalReference(path)).toBe(true);
  expect(
    localReferences(
      "[设计](</Users/Leo/设计 图.png>)\nworkspace/a.png\n[encoded](/tmp/a%20b.html)",
    ),
  ).toEqual(
    expect.arrayContaining([
      "/Users/Leo/设计 图.png",
      "workspace/a.png",
      "/tmp/a b.html",
    ]),
  );
});
