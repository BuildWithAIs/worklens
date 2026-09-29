import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import * as storage from "../src/main/storage";
import { AgentService } from "../src/main/agent-service";
import { mockServer, fixtureModel } from "./mock-server";
import type {
  ConversationView,
  Selection,
  ChatEvent,
} from "../src/shared/contracts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const image = {
  name: "sample.png",
  mimeType: "image/png" as const,
  data: "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGNoCX0HRwzEcQDdEhxxGEJJKQAAAABJRU5ErkJggg==",
};
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "worklens-versions-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const paths = {
    runtime: join(root, "runtime"),
    sessions: join(root, "sessions"),
    userData: join(root, "app"),
  };
  const server = await mockServer();
  cleanups.push(server.close);
  const modelRuntime = await ModelRuntime.create({
    modelsPath: null,
    authPath: join(root, "auth.json"),
    allowModelNetwork: false,
  });
  modelRuntime.registerProvider("worklens-test", {
    api: "openai-completions",
    baseUrl: server.url,
    apiKey: "fixture",
    models: [{ ...fixtureModel, input: ["text", "image"] }],
  });
  await modelRuntime.refresh({ allowNetwork: false });
  const events: ChatEvent[] = [];
  const create = async () => {
    const service = new AgentService(
      modelRuntime,
      paths,
      (event) => events.push(event),
      (text) => text,
    );
    await service.initialize();
    cleanups.push(() => service.shutdown());
    return service;
  };
  const service = await create();
  const selection: Selection = {
    provider: "worklens-test",
    model: fixtureModel.id,
    thinking: "off",
  };
  const settle = async (view: ConversationView, instance = service) => {
    await expect
      .poll(() =>
        events.some(
          (event) => event.runId === view.runId && event.type === "run_end",
        ),
      )
      .toBe(true);
    return instance.open(view.id);
  };
  const send = async (
    text: string,
    conversationId?: string,
    images = [] as (typeof image)[],
  ) =>
    settle(
      await service.send({
        requestId: randomUUID(),
        text,
        conversationId,
        images,
        selection,
      }),
    );
  const edit = async (
    view: ConversationView,
    messageId: string,
    text: string,
    images: (typeof image | { existingIndex: number })[] = [],
  ) =>
    settle(
      await service.editMessage({
        conversationId: view.id,
        requestId: randomUUID(),
        messageId,
        expectedBranchId: view.branchId!,
        text,
        images,
        selection,
      }),
    );
  const select = (
    view: ConversationView,
    messageId: string,
    targetId: string,
    instance = service,
  ) =>
    instance.selectMessageVersion({
      conversationId: view.id,
      messageId,
      targetId,
      expectedBranchId: view.branchId!,
    });
  return {
    paths,
    service,
    create,
    modelRuntime,
    selection,
    server,
    events,
    settle,
    send,
    edit,
    select,
  };
}

test("edits branch before the original prompt, preserve images and continuations, and persist version selection", async () => {
  const f = await setup();
  const first = await f.send("Original prompt", undefined, [image]);
  const original = first.messages.find((m) => m.role === "user")!;
  const followed = await f.send("Original follow-up", first.id);
  const edited = await f.edit(followed, original.entryId!, "Revised prompt", [
    { existingIndex: original.images![0].index },
  ]);
  const revision = edited.messages.find((m) => m.role === "user")!;
  expect(
    edited.messages.filter((m) => m.role === "user").map((m) => m.text),
  ).toEqual(["Revised prompt"]);
  expect(revision.versions).toEqual([original.entryId, revision.entryId]);
  expect(revision.images).toHaveLength(1);
  const payload = f.server.requests.at(-1);
  expect(JSON.stringify(payload.messages)).not.toContain("Original follow-up");
  expect(JSON.stringify(payload.messages)).not.toContain("Original prompt");
  expect(JSON.stringify(payload.messages)).toContain(image.data);
  expect(JSON.stringify(edited)).not.toContain(image.data);
  const newFollowup = await f.send("Revised follow-up", first.id);
  const restored = await f.select(
    newFollowup,
    revision.entryId!,
    original.entryId!,
  );
  expect(
    restored.messages.filter((m) => m.role === "user").map((m) => m.text),
  ).toEqual(["Original prompt", "Original follow-up"]);
  await f.service.shutdown();
  const restarted = await f.create();
  const opened = await restarted.open(first.id);
  expect(opened.messages.map((m) => m.text)).toEqual(
    restored.messages.map((m) => m.text),
  );
  const selected = await f.select(
    opened,
    original.entryId!,
    revision.entryId!,
    restarted,
  );
  expect(
    selected.messages.filter((m) => m.role === "user").map((m) => m.text),
  ).toEqual(["Revised prompt", "Revised follow-up"]);
});

test("review: an edit validates once and leaves the old branch untouched if draft persistence fails", async () => {
  const f = await setup();
  const original = await f.send("Keep this branch");
  const available = vi.spyOn(f.modelRuntime, "getAvailable");
  const write = vi
    .spyOn(storage, "atomicJson")
    .mockRejectedValue(new Error("disk full"));
  await expect(
    f.service.editMessage({
      conversationId: original.id,
      requestId: randomUUID(),
      messageId: original.messages[0].entryId!,
      expectedBranchId: original.branchId!,
      text: "Unsaved edit",
      images: [],
      selection: f.selection,
    }),
  ).rejects.toThrow("disk full");
  const after = await f.service.open(original.id);
  expect(after.branchId).toBe(original.branchId);
  expect(after.selection).toEqual(original.selection);
  expect(after.messages).toEqual(original.messages);
  expect(after.runId).toBeUndefined();
  expect(available).toHaveBeenCalledTimes(1);
  write.mockRestore();
});

test("review: failed rollback persistence releases the run and keeps the original branch usable", async () => {
  const f = await setup();
  const original = await f.send("Original branch");
  vi.spyOn(f.modelRuntime, "hasConfiguredAuth").mockReturnValue(false);
  vi.spyOn(f.modelRuntime, "checkAuth").mockResolvedValue(undefined);
  // Exercise Pi's actual append order: mutate the memory index, then fail disk IO.
  const manager = SessionManager.prototype as unknown as {
    _persist(entry: { type: string; customType?: string }): void;
  };
  const persist = manager._persist;
  vi.spyOn(manager, "_persist").mockImplementation(function (this: typeof manager, entry) {
    if (
      entry.type === "custom" &&
      entry.customType === "worklens.branch-selection"
    )
      throw new Error("disk full");
    return persist.call(this, entry);
  });
  const failed = await f.edit(
    original,
    original.messages[0].entryId!,
    "Failed edit",
  );
  expect(failed.phase).toBe("failed");
  expect(failed.runId).toBeUndefined();
  expect(failed.branchId).toBe(original.branchId);
  expect(failed.messages).toEqual(original.messages);
  expect(f.service.diagnostics.some((text) => text.includes("分支恢复"))).toBe(
    true,
  );
  vi.restoreAllMocks();
  const continued = await f.send("Continue original", original.id);
  expect(
    continued.messages.filter((m) => m.role === "user").map((m) => m.text),
  ).toEqual(["Original branch", "Continue original"]);
});

test("review: recovery locates a nested edit hidden by another parent version and checks stale or dismissed requests", async () => {
  const f = await setup();
  const first = await f.send("Original parent");
  const second = await f.send("Nested message", first.id, [image]);
  const source = second.messages.filter((m) => m.role === "user").at(-1)!;
  // Represents a crash after the draft was accepted but before its prompt was appended.
  const runId = randomUUID();
  await storage.atomicJson(
    join(f.paths.userData, "runs", `${runId}.pending.json`),
    {
      version: 1,
      conversationId: first.id,
      runId,
      editOf: source.entryId,
      text: "Recovered nested edit",
      images: [image],
      selection: f.selection,
    },
  );
  const changed = await f.edit(
    second,
    first.messages[0].entryId!,
    "Other parent",
  );
  expect(changed.messages.some((m) => m.entryId === source.entryId)).toBe(
    false,
  );
  await f.service.shutdown();
  const restarted = await f.create();
  const current = await restarted.open(first.id);
  await expect(
    restarted.recoverMessageEdit({ runId, expectedBranchId: "stale" }),
  ).rejects.toThrow("MESSAGE_VERSION_CHANGED");
  const restored = await restarted.recoverMessageEdit({
    runId,
    expectedBranchId: current.branchId!,
  });
  expect(restored.messages.some((m) => m.entryId === source.entryId)).toBe(
    true,
  );
  expect(restored.messages[0].entryId).toBe(first.messages[0].entryId);
  await restarted.dismissRecovery(runId);
  await expect(
    restarted.recoverMessageEdit({
      runId,
      expectedBranchId: restored.branchId!,
    }),
  ).rejects.toThrow("MESSAGE_VERSION_MISSING");
});

test("nested versions stay with their parent, image removal and third revisions preserve previous versions", async () => {
  const f = await setup();
  const first = await f.send("First", undefined, [image]);
  const second = await f.send("Second", first.id, [image]);
  const source = second.messages.filter((m) => m.role === "user").at(-1)!;
  const edited = await f.edit(second, source.entryId!, "Second revised");
  const revised = edited.messages.filter((m) => m.role === "user").at(-1)!;
  expect(revised.images).toEqual([]);
  expect(edited.messages[0].entryId).toBe(first.messages[0].entryId);
  const third = await f.edit(edited, revised.entryId!, "", [image]);
  const thirdUser = third.messages.filter((m) => m.role === "user").at(-1)!;
  expect(thirdUser.versions).toEqual([
    source.entryId,
    revised.entryId,
    thirdUser.entryId,
  ]);
  const restored = await f.select(third, thirdUser.entryId!, source.entryId!);
  expect(
    restored.messages.filter((m) => m.role === "user").at(-1)!.images,
  ).toHaveLength(1);
});

test("rejects stale, foreign and active-run edits without changing the selected history", async () => {
  const f = await setup();
  const first = await f.send("First");
  const foreign = await f.send("Other conversation");
  const input = {
    conversationId: first.id,
    requestId: randomUUID(),
    messageId: first.messages[0].entryId!,
    expectedBranchId: first.branchId!,
    text: "Changed",
    images: [],
    selection: f.selection,
  };
  await expect(
    f.service.editMessage({ ...input, expectedBranchId: "stale" }),
  ).rejects.toThrow("MESSAGE_VERSION_CHANGED");
  await expect(
    f.service.editMessage({
      ...input,
      requestId: randomUUID(),
      messageId: foreign.messages[0].entryId!,
    }),
  ).rejects.toThrow("MESSAGE_VERSION_MISSING");
  await expect(
    f.service.editMessage({
      ...input,
      requestId: randomUUID(),
      images: [{ existingIndex: 0 }],
    }),
  ).rejects.toThrow("CHAT_IMAGE_MISSING");
  expect((await f.service.open(first.id)).messages).toEqual(first.messages);
  const running = await f.service.editMessage({
    ...input,
    requestId: randomUUID(),
    text: "SLOW revised request with enough content to cancel",
  });
  await expect(
    f.service.selectMessageVersion({
      conversationId: first.id,
      messageId: input.messageId,
      targetId: input.messageId,
      expectedBranchId: running.branchId!,
    }),
  ).rejects.toThrow("当前会话正在运行");
  await f.service.cancel(first.id, running.runId!);
  const cancelled = await f.settle(running);
  const current = cancelled.messages.find((m) => m.role === "user")!;
  const restored =
    current.entryId === input.messageId
      ? cancelled
      : await f.select(cancelled, current.entryId!, input.messageId);
  expect(restored.messages[0].text).toBe("First");
});

test("authentication failure before the edited prompt preserves the original branch and recovers the edit draft", async () => {
  const f = await setup();
  const original = await f.send("Keep original", undefined, [image]);
  vi.spyOn(f.modelRuntime, "hasConfiguredAuth").mockReturnValue(false);
  vi.spyOn(f.modelRuntime, "checkAuth").mockResolvedValue(undefined);
  const failed = await f.edit(
    original,
    original.messages[0].entryId!,
    "Recover revision",
    [{ existingIndex: original.messages[0].images![0].index }],
  );
  expect(failed.phase).toBe("failed");
  expect(failed.messages.map((m) => m.text)).toEqual(
    original.messages.map((m) => m.text),
  );
  expect(f.server.requests).toHaveLength(1);
  vi.restoreAllMocks();
  await f.service.shutdown();
  const restarted = await f.create();
  const restored = await restarted.open(original.id);
  expect(restored.messages.map((m) => m.text)).toEqual(
    original.messages.map((m) => m.text),
  );
  expect(restarted.recoveries).toEqual([
    expect.objectContaining({
      editOf: original.messages[0].entryId,
      text: "Recover revision",
      imageCount: 1,
    }),
  ]);
  expect(await restarted.recoveryImages(restarted.recoveries[0].runId)).toEqual(
    [image],
  );
});
