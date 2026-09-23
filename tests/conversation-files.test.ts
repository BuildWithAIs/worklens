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
  expect(file).toEqual({ path: external, kind: "html", produced: true });
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

test.each(["html", "png", "txt", "sh", "toml"])(
  "only successful output records mark existing %s files as produced",
  async (extension) => {
    const f = await fixture();
    const path = join(f.cwd, `result.${extension}`);
    await writeFile(path, "output");
    const ref = `workspace/result.${extension}`;
    f.mention(ref);
    f.context.messages.push({ id: "u", role: "user", text: `Read ${path}` });
    expect(
      (await inspectConversationFile(f.context, ref)).produced,
    ).toBeUndefined();
    const tool = {
      id: "t",
      role: "tool" as const,
      toolName: "read",
      status: "success" as const,
      targetPath: path,
      text: "Read",
    };
    f.context.messages.push(tool);
    expect(
      (await inspectConversationFile(f.context, ref)).produced,
    ).toBeUndefined();
    for (const toolName of ["write", "edit"]) {
      f.context.messages[f.context.messages.length - 1] = {
        ...tool,
        toolName,
        status: "error",
      };
      expect(
        (await inspectConversationFile(f.context, ref)).produced,
      ).toBeUndefined();
      f.context.messages[f.context.messages.length - 1] = { ...tool, toolName };
      expect((await inspectConversationFile(f.context, ref)).produced).toBe(
        true,
      );
      f.context.messages[f.context.messages.length - 1] = {
        ...tool,
        toolName,
        targetPath: undefined,
        args: JSON.stringify({ path: `result.${extension}` }),
      };
      expect((await inspectConversationFile(f.context, ref)).produced).toBe(
        true,
      );
    }
    f.context.messages[f.context.messages.length - 1] = {
      ...tool,
      toolName: "export",
      targetPath: undefined,
      artifacts: [{ id: "out", name: `result.${extension}`, path, size: 6 }],
    };
    expect((await inspectConversationFile(f.context, ref)).produced).toBe(true);
    f.context.messages.at(-1)!.status = "error";
    expect(
      (await inspectConversationFile(f.context, ref)).produced,
    ).toBeUndefined();
    f.context.messages.at(-1)!.status = "success";
    await rm(path);
    expect(await inspectConversationFile(f.context, ref)).toMatchObject({
      issue: "missing",
    });
  },
);

test("reference parsing keeps URLs distinct and supports spaces, Unicode and Windows paths", () => {
  for (const url of [
    "https://example.com/a.png",
    "http://example.com",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "//example.com/a.png",
  ])
    expect(isLocalReference(url)).toBe(false);
  expect(isLocalReference("settings.theme")).toBe(true); // Syntax is not output evidence.
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

test("duplicate basenames never select an arbitrary output; SVG preview uses the image pipeline", async () => {
  const f = await fixture();
  for (const directory of ["one", "two"]) {
    await mkdir(join(f.cwd, directory));
    const path = join(f.cwd, directory, "result.svg");
    await writeFile(path, '<svg xmlns="http://www.w3.org/2000/svg"/>');
    f.context.messages.push({
      id: directory,
      role: "tool",
      toolName: "bash",
      status: "success",
      text: "",
      outputPaths: [path],
    });
  }
  f.mention("result.svg");
  expect((await inspectConversationFile(f.context, "result.svg")).issue).toBe(
    "unavailable",
  );
  f.mention("one/result.svg");
  const file = await inspectConversationFile(f.context, "one/result.svg");
  expect(file).toMatchObject({ produced: true, kind: "image" });
  expect((await previewConversationFile(file)).content).toMatch(
    /^data:image\/svg\+xml;base64,/,
  );
});
