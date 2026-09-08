import { test, expect, afterEach } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  ModelRuntime,
  SessionManager,
  createAgentSession,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { AgentService } from "../src/main/agent-service";
import { FileScheduler } from "../src/main/tools";
import { resources } from "../src/main/resources";
import { mockServer, fixtureModel } from "./mock-server";
import type { ChatEvent, Selection } from "../src/shared/contracts";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "worklens-reliability-"));
  const paths = {
    runtime: join(root, "runtime"),
    sessions: join(root, "sessions"),
    userData: join(root, "app"),
  };
  const server = await mockServer();
  cleanups.push(server.close);
  const runtime = await ModelRuntime.create({ modelsPath: null });
  runtime.registerProvider("worklens-test", {
    api: "openai-completions",
    baseUrl: server.url,
    apiKey: "fixture",
    models: [fixtureModel],
  });
  await runtime.refresh({ allowNetwork: false });
  const events: ChatEvent[] = [];
  const service = new AgentService(
    runtime,
    paths,
    (event) => events.push(event),
    (x) => x,
  );
  await service.initialize();
  cleanups.push(() => service.shutdown());
  const selection: Selection = {
    provider: "worklens-test",
    model: fixtureModel.id,
    thinking: "off",
  };
  return { root, paths, server, runtime, service, events, selection };
}
test("PRD 035: 20 concurrent session pairs have no cross-session contamination", async () => {
  const { service, selection, events, paths, root } = await setup();
  for (let round = 0; round < 20; round++) {
    const [a, b] = await Promise.all(
      ["A", "B"].map((side) =>
        service.send({
          requestId: randomUUID(),
          text:
            "TOOL " +
            JSON.stringify({
              name: "write",
              args: {
                path: join(root, `round-${round}-${side}.txt`),
                content: `round-${round}-${side}`,
              },
            }),
          selection,
        }),
      ),
    );
    await expect
      .poll(
        () =>
          events.filter(
            (e) =>
              e.type === "run_end" && [a.id, b.id].includes(e.conversationId),
          ).length,
      )
      .toBe(2);
    for (const [view, marker, forbidden] of [
      [a, `round-${round}-A`, `round-${round}-B`],
      [b, `round-${round}-B`, `round-${round}-A`],
    ] as const) {
      const opened = await service.open(view.id);
      expect(opened.phase).toBe("completed");
      expect(
        opened.messages.some(
          (m) => m.toolName === "write" && m.status === "success",
        ),
      ).toBe(true);
      expect(await readFile(join(root, `${marker}.txt`), "utf8")).toBe(marker);
      expect(opened.messages.map((m) => m.text).join("")).toContain(marker);
      expect(opened.messages.map((m) => m.text).join("")).not.toContain(
        forbidden,
      );
    }
  }
  expect(await SessionManager.list(paths.runtime, paths.sessions)).toHaveLength(
    40,
  );
});
test("PRD 033: 30 independent reopen cycles preserve tool history and model", async () => {
  const { service, runtime, paths, selection, events, root } = await setup();
  const first = await service.send({
    requestId: randomUUID(),
    text:
      "TOOL " +
      JSON.stringify({
        name: "write",
        args: { path: join(root, "restore.txt"), content: "恢复基线" },
      }),
    selection,
  });
  await expect
    .poll(() => events.some((e) => e.type === "run_end"), { timeout: 15000 })
    .toBe(true);
  await service.shutdown();
  for (let index = 0; index < 30; index++) {
    const restored = new AgentService(
      runtime,
      paths,
      () => {},
      (x) => x,
    );
    await restored.initialize();
    const view = await restored.open(first.id);
    expect(
      view.messages.some(
        (m) => m.toolName === "write" && m.status === "success",
      ),
    ).toBe(true);
    expect(view.selection).toEqual(selection);
    expect(view.messages.some((m) => m.text.includes("恢复基线"))).toBe(true);
    await restored.shutdown();
  }
});
test("PRD 031, 14.2: 500 Pi sessions list under 2 seconds", async () => {
  const { service, paths } = await setup();
  const assistant = {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "stored response" }],
    api: "openai-completions" as const,
    provider: "worklens-test",
    model: fixtureModel.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
  for (let index = 0; index < 500; index++) {
    const manager = SessionManager.create(paths.runtime, paths.sessions);
    manager.appendMessage({
      role: "user",
      content: `任务 ${index}`,
      timestamp: Date.now(),
    });
    manager.appendMessage(assistant);
  }
  const started = performance.now();
  const listed = await service.list();
  const duration = performance.now() - started;
  expect(listed).toHaveLength(500);
  expect(duration).toBeLessThan(2000);
  console.log(`500 sessions: ${duration.toFixed(0)} ms`);
});
test("PRD 055: same-file wait cancels immediately and other files remain independent", async () => {
  const root = await mkdtemp(join(tmpdir(), "worklens-lock-"));
  const file = join(root, "a.txt");
  const scheduler = new FileScheduler();
  const controller = new AbortController();
  let release!: () => void;
  let entered = false;
  let waiting = false;
  let executed = false;
  const first = scheduler.run(
    file,
    undefined,
    () => {},
    async () => {
      entered = true;
      await new Promise<void>((resolve) => (release = resolve));
    },
  );
  await expect.poll(() => entered).toBe(true);
  const second = scheduler.run(
    file,
    controller.signal,
    () => {
      waiting = true;
    },
    async () => {
      executed = true;
    },
  );
  const rejection = expect(second).rejects.toThrow("取消");
  await expect.poll(() => waiting).toBe(true);
  controller.abort();
  await rejection;
  expect(executed).toBe(false);
  expect(
    await scheduler.run(
      join(root, "b.txt"),
      undefined,
      () => {},
      async () => "independent",
    ),
  ).toBe("independent");
  release();
  await first;
  expect(
    await scheduler.run(
      file,
      undefined,
      () => {},
      async () => "released",
    ),
  ).toBe("released");
});
test.skipIf(process.platform !== "win32")(
  "PRD 044: PowerShell cancellation terminates its descendant process",
  async () => {
    const { service, selection, root, events } = await setup();
    const pidFile = join(root, "child.pid");
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const command = `$taskChild = Start-Process -FilePath powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile', '-Command', 'Start-Sleep -Seconds 30' -PassThru; Set-Content -LiteralPath ${quote(pidFile)} -Value $taskChild.Id; Wait-Process -Id $taskChild.Id`;
    const view = await service.send({
      requestId: randomUUID(),
      text:
        "TOOL " +
        JSON.stringify({ name: "powershell", args: { command, timeout: 40 } }),
      selection,
    });
    let pid = 0;
    await expect
      .poll(
        async () => {
          try {
            pid = Number((await readFile(pidFile, "utf8")).trim());
            return pid > 0;
          } catch {
            return false;
          }
        },
        { timeout: 10000 },
      )
      .toBe(true);
    cleanups.push(async () => {
      try {
        process.kill(pid);
      } catch {}
    });
    await service.cancel(view.id, view.runId!);
    await expect
      .poll(
        () => {
          try {
            process.kill(pid, 0);
            return false;
          } catch {
            return true;
          }
        },
        { timeout: 5000 },
      )
      .toBe(true);
    expect(events.findLast((e) => e.type === "run_end")?.view.phase).toBe(
      "cancelled",
    );
  },
);
test("PRD 046: Pi compaction persists a recoverable summary", async () => {
  const { paths, runtime, service, selection, events } = await setup();
  await service.send({
    requestId: randomUUID(),
    text: "用于压缩的历史 ".repeat(200),
    selection,
  });
  await expect
    .poll(() => events.some((e) => e.type === "run_end"), { timeout: 15000 })
    .toBe(true);
  await service.shutdown();
  const info = (await SessionManager.list(paths.runtime, paths.sessions))[0];
  const manager = SessionManager.open(info.path, paths.sessions, paths.runtime);
  const local = await resources(paths.runtime, paths.userData);
  const { session } = await createAgentSession({
    ...local,
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: true, keepRecentTokens: 32, reserveTokens: 64 },
    }),
    cwd: paths.runtime,
    agentDir: paths.userData,
    modelRuntime: runtime,
    model: runtime.getModel(selection.provider, selection.model),
    sessionManager: manager,
    tools: [],
  });
  cleanups.push(async () => session.dispose());
  await session.compact();
  expect(
    SessionManager.open(info.path, paths.sessions, paths.runtime)
      .getBranch()
      .some((e) => e.type === "compaction"),
  ).toBe(true);
  const restored = new AgentService(
    runtime,
    paths,
    () => {},
    (value) => value,
  );
  await restored.initialize();
  const history = await restored.open(manager.getSessionId());
  expect(
    history.messages.some(
      (message) =>
        message.role === "user" && message.text.startsWith("用于压缩的历史"),
    ),
  ).toBe(true);
  expect(history.messages.some((message) => message.role === "summary")).toBe(
    true,
  );
  await restored.shutdown();
});
