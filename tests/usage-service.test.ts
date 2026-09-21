import { test, expect, afterEach } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  writeFile,
  rm,
  rename,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { AgentService } from "../src/main/agent-service";
import { mockServer, fixtureModel } from "./mock-server";
import type { ChatEvent, Selection } from "../src/shared/contracts";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "worklens-usage-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const paths = {
    runtime: join(root, "runtime"),
    sessions: join(root, "sessions"),
    userData: join(root, "app"),
  };
  const server = await mockServer(options);
  cleanups.push(server.close);
  const runtime = await ModelRuntime.create({ modelsPath: null });
  runtime.registerProvider("worklens-test", {
    api: "openai-completions",
    baseUrl: server.url,
    apiKey: "fixture",
    models: [
      {
        ...fixtureModel,
        cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
      },
    ],
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
  const send = (text: string, conversationId?: string) =>
    service.send({ text, conversationId, requestId: randomUUID(), selection });
  const end = async (runId?: string) => {
    await expect
      .poll(
        () => events.find((e) => e.type === "run_end" && e.runId === runId),
        { timeout: 15000 },
      )
      .toBeTruthy();
    return events.find((e) => e.type === "run_end" && e.runId === runId)!;
  };
  const restart = async () => {
    const next = new AgentService(
      runtime,
      paths,
      () => {},
      (x) => x,
    );
    await next.initialize();
    cleanups.push(() => next.shutdown());
    return next;
  };
  return {
    root,
    paths,
    server,
    runtime,
    service,
    selection,
    events,
    send,
    end,
    restart,
  };
}

test("final response is accounted once; subsequent run, reopen and restart preserve attribution", async () => {
  const { send, end, service, restart, paths, events } = await setup();
  const first = await send("first");
  expect(first.usage?.run).toMatchObject({ state: "active", total: 0 });
  const final = await end(first.runId);
  expect(final.view.usage?.run).toMatchObject({
    state: "completed",
    total: 140,
    cost: { status: "complete" },
  });
  expect(final.view.usage?.conversation.total).toBe(140);
  // Every published stable assistant response already includes the corresponding append.
  for (const event of events.filter((e) =>
    e.view.messages.some((m) => m.role === "assistant" && m.id !== "stream"),
  ))
    expect(event.view.usage?.conversation.total).toBe(140);
  const second = await send("second", first.id);
  const secondEnd = await end(second.runId);
  expect(secondEnd.view.usage?.run?.total).toBe(140);
  expect(secondEnd.view.usage?.conversation.total).toBe(280);
  expect(service.getGlobalUsage().totalTokens).toBe(280);
  expect((await service.open(first.id)).usage).toEqual(secondEnd.view.usage);
  const next = await restart();
  const reopened = await next.open(first.id);
  expect(reopened.usage).toEqual(secondEnd.view.usage);
  expect(next.getGlobalUsage().totalTokens).toBe(280);
  await expect
    .poll(async () =>
      (await readdir(join(paths.userData, "runs"))).filter((f) =>
        f.endsWith("pending.json"),
      ),
    )
    .toEqual([]);
});

test("failed and pre-response cancelled runs have terminal attribution, without fabricated usage", async () => {
  const failed = await setup({ failAlways: true });
  const f = await failed.send("fail");
  const done = await failed.end(f.runId);
  expect(done.view.phase).toBe("failed");
  expect(done.view.usage?.run).toMatchObject({
    state: "failed",
    status: "unavailable",
  });
  const restoredFailure = await (await failed.restart()).open(f.id);
  expect(restoredFailure.messages.findLast((message) => message.role === "assistant"))
    .toMatchObject({ status: "error", error: expect.any(String) });
  const cancelled = await setup();
  const c = await cancelled.send("SLOW " + "wait ".repeat(80));
  await cancelled.service.cancel(c.id, c.runId!);
  const stopped = await cancelled.end(c.runId);
  expect(stopped.view.usage?.run?.state).toBe("cancelled");
  expect(stopped.view.usage?.run?.total ?? 0).toBe(0);
  const next = await cancelled.restart();
  const files = await readdir(cancelled.paths.sessions);
  if (files.some((f) => f.endsWith(".jsonl")))
    expect((await next.open(c.id)).usage?.run?.state).toBe("cancelled");
  else expect(next.recoveries.some((r) => r.runId === c.runId)).toBe(true);
});

test("retry remains one attributed run and preserves missing failed-request coverage", async () => {
  const { send, end, server } = await setup({ failFirst: 1 });
  const first = await send("retry once");
  const final = await end(first.runId);
  expect(server.requests.length).toBeGreaterThan(1);
  expect(final.view.usage?.run).toMatchObject({
    runId: first.runId,
    state: "completed",
    total: 140,
    status: "partial",
  });
});

test("pending-only crash recovery and materialized missing run-end remain incomplete", async () => {
  const { paths, restart, send, end } = await setup();
  const pendingId = randomUUID();
  await writeFile(
    join(paths.userData, "runs", `${pendingId}.pending.json`),
    JSON.stringify({
      version: 1,
      runId: pendingId,
      text: "accepted before materialization",
      startedAt: new Date().toISOString(),
    }),
  );
  expect((await restart()).recoveries.some((r) => r.runId === pendingId)).toBe(
    true,
  );
  const first = await send("materialize");
  await end(first.runId);
  const file = (await SessionManager.listAll(paths.sessions))[0].path;
  const lines = (await readFile(file, "utf8"))
    .trim()
    .split("\n")
    .filter((line) => JSON.parse(line).customType !== "worklens.run-end");
  await writeFile(file, lines.join("\n") + "\n");
  const next = await restart();
  expect((await next.open(first.id)).usage?.run).toMatchObject({
    state: "incomplete",
    total: 140,
  });
});

test("interleaved sessions, failed delete and successful delete preserve global revisions", async () => {
  const { send, end, service, paths, root, events } = await setup();
  const [a, b] = await Promise.all([send("A"), send("SLOW B")]);
  await Promise.all([end(a.runId), end(b.runId)]);
  expect(service.getGlobalUsage()).toMatchObject({
    totalTokens: 280,
    sessionCount: 2,
  });
  const revisions = events.map((e) => e.globalUsage!.revision);
  expect(revisions).toEqual([...revisions].sort((a, b) => a - b));
  const file = (await SessionManager.listAll(paths.sessions)).find(
    (s) => s.id === a.id,
  )!.path;
  const outside = join(root, "outside.jsonl");
  await rename(file, outside);
  await symlink(outside, file);
  const before = service.getGlobalUsage();
  await expect(service.delete(a.id)).rejects.toThrow("专属会话目录之外");
  expect(service.getGlobalUsage()).toEqual(before);
  await rm(file);
  await rename(outside, file);
  await service.delete(a.id);
  expect(service.getGlobalUsage()).toMatchObject({
    totalTokens: 140,
    sessionCount: 1,
  });
  const running = await send("SLOW " + "remaining ".repeat(40), b.id);
  await service.delete(b.id);
  await end(running.runId);
  expect(service.getGlobalUsage()).toMatchObject({
    totalTokens: 0,
    sessionCount: 0,
    status: "complete",
  });
});

test("unreadable retained file is unavailable, not zero, and remains intact", async () => {
  const { paths, restart } = await setup();
  await mkdir(paths.sessions, { recursive: true });
  const file = join(paths.sessions, "broken.jsonl");
  await writeFile(file, "broken");
  const next = await restart();
  expect(next.getGlobalUsage()).toMatchObject({
    status: "unavailable",
    sessionCount: 1,
    unavailableSessionCount: 1,
  });
  expect(await readFile(file, "utf8")).toBe("broken");
});

test("a corrupt accounting line stays partial through reopen and does not duplicate the retained session", async () => {
  const { send, end, paths, restart } = await setup();
  const first = await send("corrupt tail");
  await end(first.runId);
  const file = (await SessionManager.listAll(paths.sessions))[0].path;
  await writeFile(
    file,
    (await readFile(file, "utf8")) + "{damaged-accounting\n",
  );
  const next = await restart();
  expect(next.getGlobalUsage()).toMatchObject({
    totalTokens: 140,
    status: "partial",
    sessionCount: 1,
  });
  expect((await next.open(first.id)).usage?.conversation).toMatchObject({
    total: 140,
    status: "partial",
  });
  expect(next.getGlobalUsage()).toMatchObject({
    totalTokens: 140,
    status: "partial",
    sessionCount: 1,
  });
});
