import { afterEach, expect, test } from "vitest";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isExecutableFile } from "../src/main/executable-files";

const temps: string[] = [];
afterEach(async () => {
  for (const path of temps.splice(0))
    await rm(path, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "executable-files-"));
  temps.push(root);
  return root;
}

test("treats launchers, scripts and app bundles as executable", async () => {
  const root = await fixture();
  for (const name of ["run.command", "setup.EXE", "start.bat", "link.lnk"]) {
    await writeFile(join(root, name), "");
    expect(await isExecutableFile(join(root, name), "darwin")).toBe(true);
  }
  await mkdir(join(root, "Tool.app"));
  expect(await isExecutableFile(join(root, "Tool.app"), "darwin")).toBe(true);
});

test("keeps documents openable", async () => {
  const root = await fixture();
  for (const name of ["report.pdf", "notes.md", "data.csv", "README"]) {
    await writeFile(join(root, name), "");
    expect(await isExecutableFile(join(root, name), "darwin")).toBe(false);
  }
  await mkdir(join(root, "results"));
  expect(await isExecutableFile(join(root, "results"), "darwin")).toBe(false);
});

test("applies script-host extensions on Windows only", async () => {
  const root = await fixture();
  await writeFile(join(root, "build.js"), "");
  expect(await isExecutableFile(join(root, "build.js"), "win32")).toBe(true);
  expect(await isExecutableFile(join(root, "build.js"), "darwin")).toBe(false);
});

test.skipIf(process.platform === "win32")(
  "treats files with an execute bit as executable",
  async () => {
    const root = await fixture();
    const path = join(root, "install");
    await writeFile(path, "#!/bin/sh\n");
    expect(await isExecutableFile(path)).toBe(false);
    await chmod(path, 0o755);
    expect(await isExecutableFile(path)).toBe(true);
  },
);
