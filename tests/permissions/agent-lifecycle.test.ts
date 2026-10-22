import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AgentService } from "../../src/main/agent-service";
import * as storage from "../../src/main/storage";
import type { ChatEvent } from "../../src/shared/contracts";
import { mockServer, fixtureModel } from "../mock-server";
import { disposeWith, fixture, input } from "./helpers";

async function setup() {
  const f = await fixture();
  f.service.endTask("conversation-a");
  const server = await mockServer({ delayMs: 30 });
  disposeWith(server.close);
  const runtime = await ModelRuntime.create({ modelsPath: null });
  runtime.registerProvider("worklens-test", {
    api: "openai-completions",
    baseUrl: server.url,
    apiKey: "synthetic-placeholder",
    models: [fixtureModel],
  });
  await runtime.refresh({ allowNetwork: false });
  const events: ChatEvent[] = [];
  const agents = new AgentService(
    runtime,
    {
      runtime: join(f.root, "runtime"),
      sessions: join(f.root, "sessions"),
      userData: join(f.root, "app"),
    },
    (event) => events.push(event),
    (value) => value,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    f.service,
  );
  await agents.initialize();
  disposeWith(() => agents.shutdown());
  return {
    ...f,
    agents,
    events,
    selection: {
      provider: "worklens-test",
      model: "worklens-test",
      thinking: "off" as const,
    },
  };
}

test.each(["complete", "cancel", "delete", "shutdown"])(
  "real Pi run %s invalidates pending permissions and aborts the exact run context",
  async (ending) => {
    const f = await setup();
    const view = await f.agents.send({
      requestId: randomUUID(),
      text: "SLOW invented lifecycle task",
      selection: f.selection,
    });
    expect(f.service.contexts.current(view.id)?.runId).toBe(view.runId);
    const context = f.service.contexts.create(
      view.id,
      view.runId!,
      "synthetic-call",
      "agent",
    );
    const plan = f.service.prepare(context, input());
    const approved = await f.service.reply(
      {
        conversationId: view.id,
        requestId: plan.id,
        decision: "allow",
        scope: "once",
      },
      f.owner,
    );
    expect(approved.grants).toHaveLength(1);
    if (ending === "cancel") await f.agents.cancel(view.id, view.runId!);
    if (ending === "delete") await f.agents.delete(view.id);
    if (ending === "shutdown") await f.agents.shutdown();
    if (ending === "complete")
      await expect
        .poll(
          () =>
            f.events.findLast(
              (e) => e.conversationId === view.id && e.type === "run_end",
            )?.view.phase,
        )
        .toBe("completed");
    expect(context.signal.aborted).toBe(true);
    expect(f.service.contexts.current(view.id)).toBeUndefined();
    expect(f.service.snapshot(view.id).pending).toEqual([]);
    expect(f.service.snapshot(view.id).grants).toEqual([]);
    const effect = vi.fn(async () => "unexpected");
    await expect(f.execute(plan, f.validate, effect)).rejects.toThrow(
      "PERMISSION_STALE",
    );
    expect(effect).not.toHaveBeenCalled();
  },
);

test("failure persisting an accepted run releases its permission identity", async () => {
  const f = await setup();
  const begin = vi.spyOn(f.service, "beginTask");
  const original = storage.atomicJson;
  const write = vi
    .spyOn(storage, "atomicJson")
    .mockImplementation(async (path, value) => {
      if (path.endsWith(".pending.json"))
        throw new Error("synthetic recovery write failure");
      return original(path, value);
    });
  try {
    await expect(
      f.agents.send({
        requestId: randomUUID(),
        text: "Invented startup failure",
        selection: f.selection,
      }),
    ).rejects.toThrow("synthetic recovery write failure");
    expect(begin).toHaveBeenCalledTimes(1);
    expect(f.service.contexts.current(begin.mock.calls[0][0])).toBeUndefined();
  } finally {
    write.mockRestore();
  }
});
