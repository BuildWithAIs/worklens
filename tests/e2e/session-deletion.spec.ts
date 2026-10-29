import { test, expect, _electron as electron } from "@playwright/test";
import { createPackage } from "@electron/asar";
import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("conversation deletion removes physical archives and preserves directory boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "worklens-session-deletion-"));
  const sessions = join(root, "sessions");
  const source = join(root, "archive-source");
  const outside = join(root, "external-files");
  await mkdir(source);
  await mkdir(outside);
  await writeFile(join(source, "note.txt"), "Synthetic archive content");
  const externalArchive = join(outside, "reference.asar");
  await createPackage(source, externalArchive);
  const externalBytes = await readFile(externalArchive);
  const exportedFile = join(outside, "export.txt");
  await writeFile(exportedFile, "Keep this exported file");
  const ids = [randomUUID(), randomUUID()];
  const names = ["Archive cleanup sample", "Retained sample"];
  for (const [i, id] of ids.entries()) {
    const workspace = join(sessions, id, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "keep.txt"), "Session-owned content");
    const timestamp = new Date().toISOString();
    const records = [
      { type: "session", version: 3, id, timestamp, cwd: workspace },
      {
        type: "message",
        id: "prompt",
        parentId: null,
        timestamp,
        message: {
          role: "user",
          content: "Prepare a sample package",
          timestamp: Date.now(),
        },
      },
      {
        type: "session_info",
        id: "title",
        parentId: "prompt",
        timestamp,
        name: names[i],
      },
    ];
    await writeFile(
      join(sessions, `${id}.jsonl`),
      records.map((record) => JSON.stringify(record)).join("\n") + "\n",
    );
  }
  const directory = join(sessions, ids[0]);
  const resources = join(directory, "workspace", "package-output", "resources");
  await mkdir(resources, { recursive: true });
  await createPackage(source, join(resources, "payload.asar"));
  await writeFile(join(resources, "incomplete.asar"), "Not a valid archive");
  await mkdir(join(resources, "payload.asar.unpacked"));
  await writeFile(
    join(resources, "payload.asar.unpacked", "native.txt"),
    "Data",
  );
  await symlink(outside, join(directory, "external-directory"), "junction");
  await symlink(externalArchive, join(resources, "linked.asar"), "file");
  const index = join(root, "artifacts", "index");
  await mkdir(index, { recursive: true });
  const artifactId = randomUUID();
  await writeFile(
    join(index, `${artifactId}.json`),
    JSON.stringify({
      id: artifactId,
      sessionId: ids[0],
      path: exportedFile,
      name: "export.txt",
      size: 23,
    }),
  );
  const env: NodeJS.ProcessEnv = { ...process.env, WORKLENS_TEST_ROOT: root };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env))
    if (/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|GITHUB_TOKEN|GH_TOKEN)$/.test(key))
      delete env[key];
  const launch = () =>
    electron.launch({
      args: ["."],
      cwd: resolve("."),
      env: env as Record<string, string>,
    });
  let app: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    app = await launch();
    const page = await app.firstWindow();
    await expect(
      page.getByRole("button", { name: names[0], exact: true }),
    ).toBeVisible();
    // Even in Electron, replacing the managed root must never redirect cleanup.
    const displaced = join(root, "displaced-session");
    await rename(directory, displaced);
    await symlink(outside, directory, "junction");
    const rejection = await page.evaluate(async (id) => {
      try {
        await window.worklens.invoke("delete", { id });
        return "Unexpected success";
      } catch (error) {
        return String(error);
      }
    }, ids[0]);
    expect(rejection).toContain("symbolic link");
    expect(await readFile(externalArchive)).toEqual(externalBytes);
    await rm(directory);
    await rename(displaced, directory);

    await page
      .getByRole("button", { name: `Conversation options: ${names[0]}` })
      .click();
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Delete conversation?" });
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: names[0], exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: names[1], exact: true }),
    ).toBeVisible();
    await expect(access(directory)).rejects.toThrow();
    await expect(access(join(sessions, `${ids[0]}.jsonl`))).rejects.toThrow();
    expect(await readdir(index)).toEqual([]);
    expect(await readFile(externalArchive)).toEqual(externalBytes);
    expect(await readFile(exportedFile, "utf8")).toBe(
      "Keep this exported file",
    );
    expect(
      await readFile(join(sessions, ids[1], "workspace", "keep.txt"), "utf8"),
    ).toBe("Session-owned content");
    await app.close();
    app = await launch();
    const restarted = await app.firstWindow();
    await expect(
      restarted.getByRole("button", { name: names[1], exact: true }),
    ).toBeVisible();
    await expect(
      restarted.getByRole("button", { name: names[0], exact: true }),
    ).toHaveCount(0);
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});
