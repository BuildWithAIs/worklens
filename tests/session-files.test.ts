import { afterEach, expect, test } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  access,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { AgentService } from "../src/main/agent-service";
import { LocalArtifacts } from "../src/main/local-artifacts";
import { sessionDirectory, sessionWorkspace } from "../src/main/session-files";
import type { ChatEvent, Selection } from "../src/shared/contracts";
import { mockServer, fixtureModel } from "./mock-server";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function setup() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "worklens-session-files-")),
  );
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const paths = {
    runtime: join(root, "runtime"),
    sessions: join(root, "sessions"),
    userData: join(root, "app"),
  };
  const server = await mockServer();
  cleanup.push(server.close);
  const model = await ModelRuntime.create({ modelsPath: null });
  model.registerProvider("worklens-test", {
    name: "Local fixture",
    api: "openai-completions",
    baseUrl: server.url,
    apiKey: "test-placeholder",
    models: [fixtureModel],
  });
  await model.refresh({ allowNetwork: false });
  const selection: Selection = {
    provider: "worklens-test",
    model: "worklens-test",
    thinking: "off",
  };
  const events: ChatEvent[] = [];
  let artifacts: LocalArtifacts;
  let service: AgentService;
  const restart = async () => {
    await service?.shutdown();
    artifacts = new LocalArtifacts(
      join(root, "artifacts"),
      paths.runtime,
      paths.sessions,
    );
    service = new AgentService(
      model,
      paths,
      (event) => events.push(event),
      (text) => text,
      undefined,
      undefined,
      artifacts,
    );
    await service.initialize();
    return service;
  };
  await restart();
  cleanup.push(() => service.shutdown());
  let request = 0;
  const send = (text: string, conversationId?: string) =>
    service.send({
      text,
      conversationId,
      selection,
      requestId: `files-${++request}`,
    });
  const end = async (runId?: string) => {
    await expect
      .poll(
        () =>
          events.some(
            (event) => event.runId === runId && event.type === "run_end",
          ),
        { timeout: 15000 },
      )
      .toBe(true);
    return events.findLast(
      (event) => event.runId === runId && event.type === "run_end",
    )!.view;
  };
  const write = (content: string, conversationId?: string) =>
    send(
      "TOOL " +
        JSON.stringify({
          name: "write",
          args: { path: "report.html", content },
        }),
      conversationId,
    );
  return {
    root,
    paths,
    get service() {
      return service;
    },
    get artifacts() {
      return artifacts;
    },
    restart,
    send,
    end,
    write,
  };
}

test("relative outputs are isolated, survive restart and clean up with only their conversation", async () => {
  const f = await setup();
  const [a, b] = await Promise.all([
    f.write("<html>A</html>"),
    f.write("<html>B</html>"),
  ]);
  await Promise.all([f.end(a.runId), f.end(b.runId)]);
  const aFile = join(sessionWorkspace(f.paths.sessions, a.id), "report.html");
  const bFile = join(sessionWorkspace(f.paths.sessions, b.id), "report.html");
  expect(await readFile(aFile, "utf8")).toBe("<html>A</html>");
  expect(await readFile(bFile, "utf8")).toBe("<html>B</html>");
  await expect(access(join(f.paths.runtime, "report.html"))).rejects.toThrow();
  const downloaded = await f.artifacts.save(a.id, "download.txt", "download");
  expect(
    downloaded.path.startsWith(join(f.paths.sessions, a.id, "artifacts")),
  ).toBe(true);
  const relative = await f.artifacts.save(a.id, "relative.txt", "relative", {
    path: "relative.txt",
  });
  expect(relative.path).toBe(
    join(sessionWorkspace(f.paths.sessions, a.id), "relative.txt"),
  );
  const external = await f.artifacts.save(a.id, "external.txt", "exported", {
    path: join(f.root, "external.txt"),
  });
  await f.artifacts.copy(downloaded.id, join(f.root, "saved-copy.txt"));
  await f.restart();
  expect((await f.service.list()).map((item) => item.id)).toEqual(
    expect.arrayContaining([a.id, b.id]),
  );
  expect(
    (await f.service.open(a.id)).messages.find(
      (message) => message.toolName === "write",
    )?.targetPath,
  ).toBe(aFile);
  expect(await f.artifacts.get(downloaded.id)).toEqual(downloaded);
  const updated = await f.write("<html>A2</html>", a.id);
  await f.end(updated.runId);
  expect(await readFile(aFile, "utf8")).toBe("<html>A2</html>");
  expect(f.artifacts.resolvePath("relative.txt", a.id)).toBe(relative.path);
  await f.service.delete(a.id);
  await expect(
    access(sessionDirectory(f.paths.sessions, a.id)),
  ).rejects.toThrow();
  await expect(f.artifacts.get(downloaded.id)).rejects.toThrow();
  await expect(f.artifacts.get(external.id)).rejects.toThrow();
  expect(await readFile(external.path, "utf8")).toBe("exported");
  expect(await readFile(join(f.root, "saved-copy.txt"), "utf8")).toBe(
    "download",
  );
  expect(await readFile(bFile, "utf8")).toBe("<html>B</html>");
  await f.restart();
  expect((await f.service.list()).map((item) => item.id)).toEqual([b.id]);
  expect(f.service.getGlobalUsage().sessionCount).toBe(1);
});

test("HTML preview and native action copies belong to the conversation and reject other sessions", async () => {
  const f = await setup();
  const a = await f.write("<html>A</html>");
  await f.end(a.runId);
  const b = await f.write("<html>B</html>");
  await f.end(b.runId);
  const aFile = join(sessionWorkspace(f.paths.sessions, a.id), "report.html");
  const bFile = join(sessionWorkspace(f.paths.sessions, b.id), "report.html");
  const code = "<!doctype html><html>inline</html>";
  const linked = await f.send(
    `Files: \`${aFile}\` and \`${bFile}\`\n${code}`,
    a.id,
  );
  await f.end(linked.runId);
  expect(await f.service.previewHtml(a.id, aFile)).toBe("<html>A</html>");
  await expect(f.service.previewHtml(a.id, bFile)).rejects.toThrow();
  expect(await f.service.htmlActionFile(a.id, { path: aFile })).toBe(aFile);
  const materialized = await f.service.htmlActionFile(a.id, { code });
  expect(
    materialized.startsWith(join(f.paths.sessions, a.id, "previews")),
  ).toBe(true);
  expect(await readFile(materialized, "utf8")).toBe(code);
  await f.service.delete(a.id);
  await expect(access(materialized)).rejects.toThrow();
  expect(await readFile(bFile, "utf8")).toBe("<html>B</html>");
});

test("conversation file links resolve workspace and external output across restart", async () => {
  const f = await setup();
  const a = await f.write("<html>Local</html>");
  await f.end(a.runId);
  const external = join(f.root, "external report.html");
  const edited = await f.send(
    "TOOL " +
      JSON.stringify({
        name: "write",
        args: { path: external, content: "<html>External</html>" },
      }),
    a.id,
  );
  await f.end(edited.runId);
  const delivered = await f.send(
    `Files: \`workspace/report.html\` and [external](<${external}>)`,
    a.id,
  );
  await f.end(delivered.runId);
  for (let pass = 0; pass < 2; pass++) {
    expect(
      await f.service.conversationFile(a.id, "workspace/report.html", true),
    ).toMatchObject({
      path: join(sessionWorkspace(f.paths.sessions, a.id), "report.html"),
      kind: "html",
      content: "<html>Local</html>",
    });
    expect(await f.service.conversationFile(a.id, external, true)).toEqual({
      path: external,
      kind: "html",
      content: "<html>External</html>",
    });
    await expect(
      f.service.conversationFile(a.id, join(f.root, "unmentioned.txt")),
    ).rejects.toThrow("Unreferenced");
    if (!pass) await f.restart();
  }
});

test("legacy conversations keep their shared runtime while owned legacy downloads are cleaned", async () => {
  const f = await setup();
  const legacyFile = join(f.paths.runtime, "legacy.html");
  await writeFile(legacyFile, "<html>legacy</html>");
  const old = await f.send(`\`${legacyFile}\``);
  await f.end(old.runId);
  await f.service.shutdown();
  const info = (await SessionManager.listAll(f.paths.sessions))[0];
  const records = (await readFile(info.path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  // A pre-workspace session has no storage marker and a shared cwd in its header.
  records[0].cwd = f.paths.runtime;
  const marker = records.find(
    (record) => record.customType === "worklens.workspace",
  );
  for (const record of records)
    if (record.parentId === marker.id) record.parentId = marker.parentId;
  await writeFile(
    info.path,
    records
      .filter((record) => record !== marker)
      .map((record) => JSON.stringify(record))
      .join("\n") + "\n",
  );
  const legacyArtifacts = new LocalArtifacts(
    join(f.root, "artifacts"),
    f.paths.runtime,
  );
  const download = await legacyArtifacts.save(
    old.id,
    "legacy.txt",
    "legacy download",
  );
  // Index records created before this change did not contain session ownership.
  await writeFile(
    join(legacyArtifacts.root, "index", download.id + ".json"),
    JSON.stringify(download),
  );
  await f.restart();
  expect(await f.service.previewHtml(old.id, legacyFile)).toBe(
    "<html>legacy</html>",
  );
  const resumed = await f.write("legacy continued", old.id);
  await f.end(resumed.runId);
  expect(await readFile(join(f.paths.runtime, "report.html"), "utf8")).toBe(
    "legacy continued",
  );
  await f.service.delete(old.id);
  expect(await readFile(legacyFile, "utf8")).toBe("<html>legacy</html>");
  expect(await readFile(join(f.paths.runtime, "report.html"), "utf8")).toBe(
    "legacy continued",
  );
  await expect(access(download.path)).rejects.toThrow();
  await expect(f.artifacts.get(download.id)).rejects.toThrow();
});

test("cleanup rejects replaced session roots, is retryable, and never follows child symlinks", async () => {
  const f = await setup();
  const a = await f.write("owned");
  await f.end(a.runId);
  const directory = sessionDirectory(f.paths.sessions, a.id);
  const displaced = join(f.root, "displaced");
  const outside = join(f.root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "keep.txt"), "keep");
  await rename(directory, displaced);
  await symlink(outside, directory, "junction");
  const usage = f.service.getGlobalUsage();
  await expect(f.service.delete(a.id)).rejects.toThrow("symbolic link");
  expect((await f.service.list()).map((item) => item.id)).toContain(a.id);
  expect(f.service.getGlobalUsage()).toEqual(usage);
  expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("keep");
  await rm(directory);
  await rename(displaced, directory);
  await symlink(outside, join(directory, "external-link"), "junction");
  await f.service.delete(a.id);
  expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("keep");
  expect(await readdir(f.paths.sessions)).toEqual([]);
});

test("deleting a running conversation waits for cancellation before removing its files", async () => {
  const f = await setup();
  const a = await f.write("owned");
  await f.end(a.runId);
  const running = await f.send("SLOW " + "remaining ".repeat(40), a.id);
  await f.service.delete(a.id);
  expect((await f.end(running.runId)).phase).toBe("cancelled");
  await expect(
    access(sessionDirectory(f.paths.sessions, a.id)),
  ).rejects.toThrow();
  await f.restart();
  expect(await f.service.list()).toEqual([]);
});

test("concurrent conversation deletion tolerates changes to the shared artifact index", async () => {
  const f = await setup();
  const [a, b] = await Promise.all([f.write("A"), f.write("B")]);
  await Promise.all([f.end(a.runId), f.end(b.runId)]);
  await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      f.artifacts.save(index % 2 ? a.id : b.id, "download.txt", "download"),
    ),
  );
  await Promise.all([f.service.delete(a.id), f.service.delete(b.id)]);
  expect(await readdir(f.paths.sessions)).toEqual([]);
  expect(await readdir(join(f.artifacts.root, "index"))).toEqual([]);
});
