import { test, expect } from "vitest";
import { mkdtemp, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { resources } from "../src/main/resources";
import { fixtureModel, mockServer } from "./mock-server";

test("Pi 0.85.1: notification precedes append, microtask observes append, first assistant materializes custom history", async () => {
  const root = await mkdtemp(join(tmpdir(), "worklens-pi-usage-"));
  const server = await mockServer();
  const runtime = await ModelRuntime.create({ modelsPath: null });
  runtime.registerProvider("worklens-test", {
    api: "openai-completions",
    baseUrl: server.url,
    apiKey: "fixture",
    models: [fixtureModel],
  });
  await runtime.refresh({ allowNetwork: false });
  const manager = SessionManager.create(root, join(root, "sessions"));
  const startId = manager.appendCustomEntry("worklens.run-start", {
    version: 1,
    runId: "audit",
  });
  await expect(access(manager.getSessionFile()!)).rejects.toThrow();
  const { session } = await createAgentSession({
    ...(await resources(root, join(root, "pi"))),
    cwd: root,
    agentDir: join(root, "pi"),
    modelRuntime: runtime,
    model: runtime.getModel("worklens-test", fixtureModel.id),
    sessionManager: manager,
    tools: [],
  });
  let before = -1,
    after = -1;
  session.subscribe((event) => {
    if (event.type === "message_end" && event.message.role === "assistant") {
      before = session.getSessionStats().tokens.total;
      queueMicrotask(() => {
        after = session.getSessionStats().tokens.total;
      });
    }
  });
  try {
    await session.prompt("usage audit");
    expect(before).toBe(0);
    expect(after).toBe(140);
    const reopened = SessionManager.open(
      manager.getSessionFile()!,
      join(root, "sessions"),
      root,
    );
    expect(reopened.getEntries().some((e) => e.id === startId)).toBe(true);
    const assistant = reopened
      .getEntries()
      .find((e) => e.type === "message" && e.message.role === "assistant");
    expect(assistant).toMatchObject({
      message: {
        usage: { input: 80, output: 40, cacheRead: 20, cacheWrite: 0 },
      },
    });
    const usage = {
      input: 2,
      output: 3,
      cacheRead: 4,
      cacheWrite: 1,
      totalTokens: 10,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    manager.appendCompaction("summary", startId, 140, undefined, false, usage);
    expect(session.getSessionStats().tokens.total).toBe(150);
    expect(session.getContextUsage()?.tokens).toBeNull();
    expect(
      SessionManager.open(
        manager.getSessionFile()!,
        join(root, "sessions"),
        root,
      )
        .getEntries()
        .some((e) => e.type === "compaction" && e.usage?.totalTokens === 10),
    ).toBe(true);
  } finally {
    session.dispose();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
