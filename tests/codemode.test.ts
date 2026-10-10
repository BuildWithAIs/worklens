import { afterEach, expect, test } from "vitest";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { AgentService } from "../src/main/agent-service";
import { McpService } from "../src/main/mcp-service";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { mockServer, fixtureModel } from "./mock-server";
import type { ChatEvent, Selection } from "../src/shared/contracts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "worklens-codemode-"));
  const paths = {
    runtime: join(root, "runtime"),
    sessions: join(root, "sessions"),
    userData: join(root, "app"),
  };
  const server = await mockServer();
  cleanup.push(server.close);
  const modelRuntime = await ModelRuntime.create({
    modelsPath: null,
    authPath: join(root, "auth.json"),
  });
  modelRuntime.registerProvider("worklens-test", {
    api: "openai-completions",
    baseUrl: server.url,
    apiKey: "fixture",
    models: [fixtureModel],
  });
  await modelRuntime.refresh({ allowNetwork: false });
  const mcp = new McpService(join(root, "mcp"), {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(text),
    decryptString: (buffer) => buffer.toString(),
  });
  mcp.initialize();
  mcp.save(
    JSON.stringify({
      mcpServers: {
        fixture: {
          displayName: "Paper trail",
          command: process.execPath,
          args: [resolve("tests/fixtures/mcp-server.mjs")],
          env: { TOKEN: "synthetic-MCP-credential" },
        },
        missing: {
          url: "https://example.invalid/mcp",
          oauth: { clientSecret: "${WORKLENS_MCP_TEST_MISSING_SECRET}" },
        },
      },
    }),
  );
  cleanup.push(() => mcp.shutdown());
  let enabled = true;
  const events: ChatEvent[] = [];
  const create = async () => {
    const service = new AgentService(
      modelRuntime,
      paths,
      (event) => events.push(event),
      (text) => mcp.redact(text),
      undefined,
      undefined,
      undefined,
      undefined,
      mcp,
      () => enabled,
    );
    await service.initialize();
    cleanup.push(() => service.shutdown());
    return service;
  };
  const service = await create();
  const selection: Selection = {
    provider: "worklens-test",
    model: fixtureModel.id,
    thinking: "off",
  };
  const send = async (
    name: string,
    args: unknown,
    conversationId?: string,
    instance = service,
  ) => {
    const initial = await instance.send({
      requestId: randomUUID(),
      selection,
      conversationId,
      text: "TOOL " + JSON.stringify({ name, args }),
    });
    await expect
      .poll(
        () =>
          events.some(
            (event) =>
              event.runId === initial.runId && event.type === "run_end",
          ),
        { timeout: 15000 },
      )
      .toBe(true);
    return instance.open(initial.id);
  };
  return {
    service,
    create,
    events,
    send,
    paths,
    server,
    selection,
    disable: () => {
      enabled = false;
    },
  };
}

test("Code Mode composes MCP and file tools, persists nested history and store across restart", async () => {
  const f = await setup();
  const view = await f.send("codemode", {
    code: 'await describeNamespace("mcp__fixture"); const results = await Promise.all([tools.mcp__fixture__echo({text:"MCP_OK"}), tools.write({path:"nested.txt",content:"FILE_OK"}), tools.read_mcp_resource({server:"fixture",uri:"fixture://hello"})]); for (const result of results) text(result); text(await tools.mcp__fixture__echo({text:"RETURN_SECRET"})); store("answer",42);',
  });
  expect(view.phase).toBe("completed");
  expect(
    f.service.diagnostics.some((message) =>
      message.includes("WORKLENS_MCP_TEST_MISSING_SECRET"),
    ),
  ).toBe(true);
  const parent = view.messages.find(
    (message) => message.toolName === "codemode",
  )!;
  expect(parent.status).toBe("success");
  expect(parent.text).toContain("MCP_OK");
  expect(parent.text).toContain("MCP_RESOURCE_OK");
  expect(parent.text).toContain("[redacted]");
  const transcript = (await readdir(f.paths.sessions)).find((file) =>
    file.endsWith(`_${view.id}.jsonl`),
  )!;
  expect(
    await readFile(join(f.paths.sessions, transcript), "utf8"),
  ).not.toContain("synthetic-MCP-credential");
  const nested = view.messages.filter(
    (message) => message.parentToolCallId === parent.toolId,
  );
  expect(nested.map((message) => message.toolName).sort()).toEqual([
    "mcp__fixture__echo",
    "mcp__fixture__echo",
    "read_mcp_resource",
    "write",
  ]);
  expect(nested.every((message) => message.status === "success")).toBe(true);
  expect(
    await readFile(
      join(f.paths.sessions, view.id, "workspace", "nested.txt"),
      "utf8",
    ),
  ).toBe("FILE_OK");
  expect(
    nested.find((message) => message.toolName === "write")?.targetPath,
  ).toBe(join(f.paths.sessions, view.id, "workspace", "nested.txt"));
  await f.service.shutdown();
  const restarted = await f.create();
  expect(
    (await restarted.open(view.id)).messages.filter(
      (message) => message.parentToolCallId,
    ),
  ).toEqual(nested);
  const next = await f.send(
    "codemode",
    { code: 'text(load("answer"));' },
    view.id,
    restarted,
  );
  expect(
    next.messages.findLast((message) => message.toolName === "codemode")?.text,
  ).toContain("42");
  expect(f.server.requests).toHaveLength(4);
});

test.each([
  ["RETURN_STRUCTURED", false],
  ["RETURN_STRUCTURED_ERROR", true],
])(
  "Code Mode preserves MCP structured results and redacts their strings (%s)",
  async (text, isError) => {
    const f = await setup();
    const view = await f.send("codemode", {
      code: `await describeNamespace("mcp__fixture"); const result = await tools.mcp__fixture__echo({text:${JSON.stringify(text)}}); text(JSON.stringify({content:result.content, rows:result.structuredContent.rows.filter(row=>row.active), count:result.structuredContent.count, isError:result.isError}));`,
    });
    const expected = JSON.stringify({
      content: [{ type: "text", text: "MCP_STRUCTURED_SUMMARY [redacted]" }],
      rows: [
        {
          name: "招聘费用",
          amount: 125.5,
          active: true,
          note: null,
          credentials: { token: "[redacted]" },
        },
      ],
      count: 1,
      isError,
    });
    expect(view.phase).toBe("completed");
    const parent = view.messages.find(
      (message) => message.toolName === "codemode",
    )!;
    expect(parent.status).toBe("success");
    expect(parent.text).toContain(expected);
    expect(
      view.messages.find(
        (message) => message.parentToolCallId === parent.toolId,
      ),
    ).toMatchObject({
      toolName: "mcp__fixture__echo",
      status: isError ? "error" : "success",
      text: "MCP_STRUCTURED_SUMMARY [redacted]",
    });
    const transcript = (await readdir(f.paths.sessions)).find((file) =>
      file.endsWith(`_${view.id}.jsonl`),
    )!;
    expect(
      await readFile(join(f.paths.sessions, transcript), "utf8"),
    ).not.toContain("synthetic-MCP-credential");
  },
);

test("Code Mode propagates nested errors and cancellation; disabling it preserves deferred MCP discovery", async () => {
  const f = await setup();
  const failed = await f.send("codemode", {
    code: 'await describeNamespace("mcp__fixture"); text(await tools.mcp__fixture__fail({}));',
  });
  expect(
    failed.messages.find(
      (message) => message.toolName === "mcp__fixture__fail",
    ),
  ).toMatchObject({ status: "error", text: "MCP_FIXTURE_ERROR" });
  const slow = await f.service.send({
    requestId: randomUUID(),
    selection: f.selection,
    text:
      "TOOL " +
      JSON.stringify({
        name: "codemode",
        args: {
          code: 'await describeNamespace("mcp__fixture"); text(await tools.mcp__fixture__slow({}));',
        },
      }),
  });
  await expect
    .poll(
      async () =>
        (await f.service.open(slow.id)).messages.some(
          (message) =>
            message.toolName === "mcp__fixture__slow" &&
            message.status === "running",
        ),
      { timeout: 15000 },
    )
    .toBe(true);
  await f.service.cancel(slow.id, slow.runId!);
  const stopped = await f.service.open(slow.id);
  expect(stopped.phase).toBe("cancelled");
  expect(
    stopped.messages.find(
      (message) => message.toolName === "mcp__fixture__slow",
    )?.status,
  ).toBe("cancelled");
  f.disable();
  const discovered = await f.send("tool_search", { query: "echo" }, failed.id);
  expect(
    discovered.messages.findLast(
      (message) => message.toolName === "tool_search",
    )?.text,
  ).toContain("mcp__fixture__echo");
  const direct = await f.send(
    "mcp__fixture__echo",
    { text: "DEFERRED_OK" },
    discovered.id,
  );
  expect(
    direct.messages.findLast(
      (message) => message.toolName === "mcp__fixture__echo",
    )?.text,
  ).toContain("DEFERRED_OK");
  expect(
    f.server.requests
      .at(-1)
      .tools.some((tool: any) => tool.function.name === "codemode"),
  ).toBe(false);
});
