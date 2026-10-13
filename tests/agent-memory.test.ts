import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { AgentService } from "../src/main/agent-service";
import { sessionWorkspace } from "../src/main/session-files";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(count: number) {
  const root = await mkdtemp(join(tmpdir(), "worklens-memory-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const paths = {
    runtime: join(root, "runtime"),
    sessions: join(root, "sessions"),
    userData: join(root, "app"),
  };
  const service = new AgentService(
    await ModelRuntime.create({
      modelsPath: null,
      authPath: join(root, "auth.json"),
      allowModelNetwork: false,
    }),
    paths,
    () => {},
    (text) => text,
  );
  await service.initialize();
  cleanups.push(() => service.shutdown());
  const ids = Array.from({ length: count }, () => randomUUID());
  for (const id of ids) {
    const manager = SessionManager.create(
      sessionWorkspace(paths.sessions, id),
      paths.sessions,
      { id },
    );
    manager.appendMessage({ role: "user", content: id, timestamp: 1 });
    // Pi writes the session file with the first assistant message.
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      api: "openai-completions",
      provider: "test",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    });
  }
  return { service, ids, paths };
}

test("keeps a bounded number of idle conversations in memory", async () => {
  const { service, ids } = await setup(15);
  const sessions = (service as unknown as { sessions: Map<string, unknown> })
    .sessions;
  await service.open(ids[0]);
  for (const id of ids.slice(1)) {
    await service.open(id);
    // The first conversation stays because it is used again.
    await service.open(ids[0]);
  }
  expect(sessions.size).toBe(12);
  expect(sessions.has(ids[0])).toBe(true);
  expect(sessions.has(ids[1])).toBe(false);
  // Evicted conversations reload from disk.
  expect((await service.open(ids[1])).messages[0].text).toBe(ids[1]);
});

test("reads unchanged session files once across list refreshes", async () => {
  const { service, ids, paths } = await setup(3);
  const open = vi.spyOn(SessionManager, "open");
  const listAll = vi.spyOn(SessionManager, "listAll");
  expect((await service.list()).map((item) => item.id).sort()).toEqual(
    [...ids].sort(),
  );
  expect(open).toHaveBeenCalledTimes(3);
  await service.list();
  expect(open).toHaveBeenCalledTimes(3);
  expect(listAll).toHaveBeenCalledTimes(1);
  // Opening a listed conversation does not scan every session again.
  listAll.mockClear();
  await service.open(ids[0]);
  expect(listAll).not.toHaveBeenCalled();
  // A changed file is read again.
  const [changed] = (await SessionManager.listAll(paths.sessions)).filter(
    (info) => info.id !== ids[0],
  );
  await utimes(changed.path, new Date(), new Date(Date.now() + 5000));
  open.mockClear();
  await service.list();
  expect(open).toHaveBeenCalledTimes(1);
});
