import { afterEach, expect, test } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  readFile,
  realpath,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { observeFileOutputs } from "../src/main/file-outputs";
import { worklensTools } from "../src/main/tools";
import { projectMessages } from "../src/main/projection";
import { inspectConversationFile } from "../src/main/conversation-files";

const temps: string[] = [];
afterEach(async () => {
  for (const path of temps.splice(0))
    await rm(path, { recursive: true, force: true });
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "output-records-")));
  temps.push(root);
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  return { root, cwd };
}

test("metadata collection covers arbitrary formats, extensionless names, renames, and modifications, excluding reads and symlinks", async () => {
  const { root, cwd } = await fixture();
  await writeFile(join(cwd, "unchanged.svg"), "old");
  await writeFile(join(cwd, "changed.future-format"), "old");
  await writeFile(join(root, "outside"), "external");
  await symlink(root, join(cwd, "escape"));
  const collect = await observeFileOutputs(cwd);
  await readFile(join(cwd, "unchanged.svg"));
  await mkdir(join(cwd, "logo"));
  for (const name of [
    "result.svg",
    "result.png",
    "download.uninventedformat123456789",
    "README",
    ".env",
    "报告 最终版",
  ])
    await writeFile(join(cwd, "logo", name), "new");
  await writeFile(join(cwd, "changed.future-format"), "new content");
  const paths = await collect();
  expect(paths).toHaveLength(7);
  expect(paths).not.toContain(join(cwd, "unchanged.svg"));
  expect(paths.some((path) => path.includes("escape"))).toBe(false);
  expect(paths).toContain(join(cwd, "logo", "README"));
});

test("declared external outputs require an actual change and do not include unchanged input files", async () => {
  const { root, cwd } = await fixture();
  const input = join(root, "input.bin");
  const output = join(root, "output.custom");
  await writeFile(input, "input");
  const collect = await observeFileOutputs(cwd, [input, output]);
  await readFile(input);
  await writeFile(output, "output");
  expect(await collect()).toEqual([output]);
});

test.skipIf(process.platform === "win32")(
  "real shell output metadata survives projection and resolves basename aliases without extension rules",
  async () => {
    const { cwd } = await fixture();
    const shell = worklensTools(cwd, () => {}).find(
      (tool) => tool.name === "bash",
    )!;
    const result = await shell.execute(
      "shell-output",
      {
        command:
          "mkdir -p logo; printf '<svg/>' > logo/bmw-logo-white.svg; printf data > logo/README; printf data > logo/report.uninventedformat123456789; cp logo/README logo/temp; mv logo/temp logo/renamed",
      },
      undefined,
      undefined,
    );
    const details = result.details as {
      worklensShell: { exitCode: number; outputPaths: string[] };
    };
    expect(details.worklensShell.exitCode).toBe(0);
    expect(details.worklensShell.outputPaths).toHaveLength(4);
    const messages = projectMessages(
      [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "shell-output",
              name: "bash",
              arguments: { command: "fixture" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "shell-output",
          toolName: "bash",
          isError: false,
          content: result.content,
          details: JSON.parse(JSON.stringify(result.details)),
        },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "已保存 bmw-logo-white.svg、README、report.uninventedformat123456789 和 renamed。",
            },
          ],
        },
      ],
      cwd,
    );
    for (const name of [
      "bmw-logo-white.svg",
      "README",
      "report.uninventedformat123456789",
      "renamed",
    ]) {
      expect(
        await inspectConversationFile({ cwd, roots: [cwd], messages }, name),
      ).toMatchObject({ path: join(cwd, "logo", name), produced: true });
    }
    const read = await shell.execute(
      "read-only",
      { command: "cat logo/README" },
      undefined,
      undefined,
    );
    expect((read.details as typeof details).worklensShell.outputPaths).toEqual(
      [],
    );
    await expect(
      shell.execute(
        "failed",
        { command: "printf partial > failed.svg; exit 1" },
        undefined,
        undefined,
      ),
    ).rejects.toThrow();
  },
);
