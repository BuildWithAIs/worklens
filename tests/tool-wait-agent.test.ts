import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AgentService } from "../src/main/agent-service";
import { ConnectorRegistry } from "../src/main/connectors/registry";
import { ToolQueue } from "../src/main/tool-queue";
import type { ChatEvent } from "../src/shared/contracts";
import { mockServer, fixtureModel } from "./mock-server";

test.each([false, true])(
  "new connectors publish transient wait state through AgentService (Code Mode: %s)",
  async (nested) => {
    const root = await mkdtemp(join(tmpdir(), "worklens-tool-wait-"));
    const server = await mockServer();
    const runtime = await ModelRuntime.create({ modelsPath: null });
    runtime.registerProvider("worklens-test", {
      api: "openai-completions",
      baseUrl: server.url,
      apiKey: "fixture",
      models: [fixtureModel],
    });
    await runtime.refresh({ allowNetwork: false });
    const queue = new ToolQueue(1);
    let release!: () => void;
    const blocker = queue.run(
      new AbortController().signal,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const events: ChatEvent[] = [];
    const service = new AgentService(
      runtime,
      {
        runtime: join(root, "runtime"),
        sessions: join(root, "sessions"),
        userData: join(root, "app"),
      },
      (event) => events.push(structuredClone(event)),
      (text) => text,
      new ConnectorRegistry([
        {
          id: "fixture",
          instructions: "",
          initialize: async () => {},
          configurationKey: () => "fixture",
          names: () => ["fixture_wait"],
          redact: (text) => text,
          tools: () => [
            {
              name: "fixture_wait",
              label: "Fixture",
              description: "Wait fixture",
              parameters: Type.Object({}),
              execute: async (_id, _args, signal) =>
                queue.run(signal ?? new AbortController().signal, async () => ({
                  content: [{ type: "text", text: "UNCHANGED_RESULT" }],
                  details: {},
                })),
            },
          ],
        },
      ]),
    );
    try {
      await service.initialize();
      const view = await service.send({
        requestId: randomUUID(),
        text:
          "TOOL " +
          JSON.stringify(
            nested
              ? {
                  name: "codemode",
                  args: { code: "text(await tools.fixture_wait({}));" },
                }
              : { name: "fixture_wait", args: {} },
          ),
        selection: {
          provider: "worklens-test",
          model: fixtureModel.id,
          thinking: "off",
        },
      });
      await expect
        .poll(
          () =>
            events.some((event) =>
              event.view?.messages.some(
                (message) =>
                  message.toolName === "fixture_wait" &&
                  message.status === "waiting" &&
                  message.waitReason === "queue",
              ),
            ),
          { timeout: 10000 },
        )
        .toBe(true);
      const waiting = events
        .flatMap((event) => event.view?.messages ?? [])
        .find(
          (message) =>
            message.toolName === "fixture_wait" && message.status === "waiting",
        )!;
      expect(!!waiting.parentToolCallId).toBe(nested);
      release();
      await blocker;
      await expect
        .poll(() => events.some((event) => event.type === "run_end"), {
          timeout: 10000,
        })
        .toBe(true);
      const completed = await service.open(view.id);
      const tool = completed.messages.find(
        (message) => message.toolName === "fixture_wait",
      )!;
      expect(tool.status).toBe("success");
      expect(tool.waitReason).toBeUndefined();
      expect(tool.text).toContain("UNCHANGED_RESULT");
      expect(
        completed.messages.some((message) => message.status === "waiting"),
      ).toBe(false);
    } finally {
      release();
      await blocker;
      await service.shutdown();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
