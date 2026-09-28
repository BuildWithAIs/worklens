import { join } from "node:path";
import { expect, test } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AgentService } from "../../../src/main/agent-service";
import { LocalArtifacts } from "../../../src/main/local-artifacts";
import type { ChatEvent, Selection } from "../../../src/shared/contracts";
import { mockServer, fixtureModel } from "../../mock-server";
import { setup, sample, onCleanup } from "./setup";

async function runtimeSetup() {
  let agent: AgentService | undefined;
  const f = await setup((id) => agent?.connectorConsentChanged(id));
  const server = await mockServer();
  onCleanup(server.close);
  const runtime = await ModelRuntime.create({ modelsPath: null });
  runtime.registerProvider("worklens-test", {
    name: "Local fixture",
    api: "openai-completions",
    baseUrl: server.url,
    apiKey: "test-placeholder",
    models: [fixtureModel],
  });
  await runtime.refresh({ allowNetwork: false });
  const paths = {
    runtime: join(f.root, "runtime"),
    sessions: join(f.root, "sessions"),
    userData: join(f.root, "app"),
  };
  const events: ChatEvent[] = [];
  agent = new AgentService(
    runtime,
    paths,
    (event) => events.push(event),
    (text) => text,
    f.registry,
    undefined,
    new LocalArtifacts(
      join(f.root, "artifacts"),
      paths.sessions,
    ),
    f.consent,
  );
  await agent.initialize();
  onCleanup(() => agent!.shutdown());
  const selection: Selection = {
    provider: "worklens-test",
    model: "worklens-test",
    thinking: "off",
  };
  return { ...f, agent, selection, events, server };
}

test("real Pi pauses at the approval card, resumes after approval, and isolates simultaneous conversations", async () => {
  const f = await runtimeSetup();
  const text = `TOOL ${JSON.stringify({ name: "jev_classify", args: sample })}`;
  const first = await f.agent.send({
    text,
    requestId: "first",
    selection: f.selection,
  });
  const second = await f.agent.send({
    text,
    requestId: "second",
    selection: f.selection,
  });
  await expect.poll(() => f.consent.view(first.id).pending.length).toBe(1);
  await expect.poll(() => f.consent.view(second.id).pending.length).toBe(1);
  expect(
    f.state.requests.filter(({ path }) => path === "/v1/systemone"),
  ).toHaveLength(0);
  expect(
    f.events.some(
      (event) =>
        event.type === "connector_consent" &&
        event.view.jevConsent?.pending.length,
    ),
  ).toBe(true);
  const request = f.consent.view(first.id).pending[0];
  const accepted = await f.agent.replyJevConsent(first.id, request.id, true);
  expect(accepted.jevConsent?.approvedBatches).toBe(1);
  await expect
    .poll(async () => (await f.agent.open(first.id)).phase, { timeout: 15000 })
    .toBe("completed");
  expect(f.consent.view(second.id).pending).toHaveLength(1);
  await f.agent.replyJevConsent(
    second.id,
    f.consent.view(second.id).pending[0].id,
    false,
  );
  await expect
    .poll(async () => (await f.agent.open(second.id)).phase, { timeout: 15000 })
    .toBe("completed");
  expect(
    f.state.requests.filter(({ path }) => path === "/v1/systemone"),
  ).toHaveLength(1);
  expect((await f.agent.open(second.id)).jevConsent?.blocked).toBe(true);
  const tools = (await f.agent.open(first.id)).messages.filter(
    (message) => message.role === "tool",
  );
  expect(
    tools.some(
      (message) =>
        message.toolName === "jev_classify" && message.status === "success",
    ),
  ).toBe(true);
});

test("stopping a real Pi run closes consent without sending, and deletion removes session permission", async () => {
  const f = await runtimeSetup();
  const view = await f.agent.send({
    text: `TOOL ${JSON.stringify({ name: "jev_check", args: { items: sample.items, condition: "Reports a defect" } })}`,
    requestId: "cancel",
    selection: f.selection,
  });
  await expect.poll(() => f.consent.view(view.id).pending.length).toBe(1);
  const request = f.consent.view(view.id).pending[0];
  await f.agent.cancel(view.id, view.runId!);
  expect((await f.agent.open(view.id)).phase).toBe("cancelled");
  expect(f.consent.view(view.id).pending).toHaveLength(0);
  await expect(
    f.agent.replyJevConsent(view.id, request.id, true),
  ).rejects.toThrow();
  expect(
    f.state.requests.filter(({ path }) => path === "/v1/systemone"),
  ).toHaveLength(0);
  await f.agent.resetJevConsent(view.id, true);
  await f.agent.delete(view.id);
  expect(f.consent.view(view.id)).toEqual({
    blocked: false,
    autoAllowed: false,
    approvedBatches: 0,
    pending: [],
  });
});
