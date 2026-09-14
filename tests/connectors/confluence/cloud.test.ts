import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { AgentService } from "../../../src/main/agent-service";
import {
  ConfluenceHttp,
  ServiceError,
} from "../../../src/main/connectors/confluence/http";
import { ConfluenceService } from "../../../src/main/connectors/confluence/service";
import type { ChatEvent } from "../../../src/shared/contracts";
import { cleanups, setup } from "./setup";
import { fixtureModel, mockServer } from "../../mock-server";
test("Cloud scoped requests use the gateway and Basic auth; CDN redirect does not receive credentials", async () => {
  const f = await setup();
  await f.connections.save({
    url: "https://fixture.atlassian.net/wiki",
    deployment: "cloud",
    email: "fixture@example.com",
    token: "scoped-token",
    tokenType: "scoped",
    cloudId: "cloud-123",
  });
  const calls: { url: string; headers: Headers }[] = [];
  const fetcher = vi.fn(async (url: any, init: any) => {
    calls.push({ url: String(url), headers: new Headers(init.headers) });
    return calls.length === 1
      ? new Response(null, {
          status: 302,
          headers: { location: "https://cdn.example/download?signed=1" },
        })
      : new Response("bytes");
  }) as unknown as typeof fetch;
  const http = new ConfluenceHttp(f.connections.snapshot(), undefined, fetcher);
  await http.download("/rest/api/content/1/child/attachment/8/download");
  expect(calls[0].url).toContain(
    "api.atlassian.com/ex/confluence/cloud-123/wiki/",
  );
  expect(calls[0].headers.get("authorization")).toContain("Basic ");
  expect(calls[1].headers.has("authorization")).toBe(false);
  expect(http.nextPath("/wiki/api/v2/pages?cursor=next")).toBe(
    "/api/v2/pages?cursor=next",
  );
});
test("read retries respect rate-limit guidance; write 503 never automatically retries", async () => {
  const f = await setup();
  let calls = 0;
  const fetcher = vi.fn(async () => {
    calls++;
    return new Response("{}", {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const http = new ConfluenceHttp(f.connections.snapshot(), undefined, fetcher);
  await expect(
    http.json("/rest/api/content", "POST", {}),
  ).rejects.toMatchObject({ code: "unknown" });
  expect(calls).toBe(1);
  const limited = new ConfluenceHttp(
    f.connections.snapshot(),
    undefined,
    async () =>
      new Response("{}", { status: 429, headers: { "retry-after": "120" } }),
  );
  await expect(limited.json("/rest/api/search")).rejects.toBeInstanceOf(
    ServiceError,
  );
});
test("real Pi agent registers and selects Confluence tools, returns structured read results", async () => {
  const f = await setup();
  const model = await mockServer();
  cleanups.push(model.close);
  const runtime = await ModelRuntime.create({ modelsPath: null });
  runtime.registerProvider("worklens-test", {
    name: "Fixture",
    api: "openai-completions",
    baseUrl: model.url,
    apiKey: "synthetic",
    models: [fixtureModel],
  });
  await runtime.refresh({ allowNetwork: false });
  const events: ChatEvent[] = [];
  const agents = new AgentService(
    runtime,
    {
      runtime: f.root,
      sessions: join(f.root, "sessions"),
      userData: join(f.root, "app"),
    },
    (e) => events.push(e),
    (v) => f.connections.redact(v),
    f.connectors,
  );
  await agents.initialize();
  cleanups.push(() => agents.shutdown());
  const view = await agents.send({
    requestId: "confluence-agent-test",
    text: 'TOOL {"name":"confluence_read","args":{"request":{"operation":"read_page","page":"1"}}}',
    selection: {
      provider: "worklens-test",
      model: "worklens-test",
      thinking: "off",
    },
  });
  await expect
    .poll(
      () =>
        events.some(
          (e) => e.type === "run_end" && e.conversationId === view.id,
        ),
      { timeout: 25000 },
    )
    .toBe(true);
  const final = await agents.open(view.id);
  const tool = final.messages.find((m) => m.toolName === "confluence_read");
  expect(tool?.status, tool?.text).toBe("success");
  expect(tool?.text).toContain("Node 22");
  // Existing conversations continue to work after connection settings are saved.
  await f.connections.save(f.input);
  for (const [operation, status] of [
    ["describe_operation", "success"],
    ["read_page", "error"],
  ] as const) {
    const ended = events.filter((e) => e.type === "run_end").length;
    await agents.send({
      conversationId: view.id,
      requestId: `review-${operation}`,
      text: `TOOL ${JSON.stringify({ name: "confluence_read", args: { request: operation === "describe_operation" ? { operation, name: "search" } : { operation, page: "bad-id" } } })}`,
      selection: {
        provider: "worklens-test",
        model: "worklens-test",
        thinking: "off",
      },
    });
    await expect
      .poll(() => events.filter((e) => e.type === "run_end").length, {
        timeout: 25000,
      })
      .toBe(ended + 1);
    const restored = await agents.open(view.id);
    expect(
      restored.messages.filter((m) => m.toolName === "confluence_read").at(-1)
        ?.status,
    ).toBe(status);
  }
  const latest = model.requests.at(-1) as {
    tools: { function: { name: string; parameters: unknown } }[];
  };
  expect(latest.tools.some((t) => t.function.name === "confluence_write")).toBe(
    true,
  );
  const schema = latest.tools.find(
    (t) => t.function.name === "confluence_read",
  )!.function.parameters;
  expect(JSON.stringify(schema).length).toBeLessThan(2500);
  expect(JSON.stringify(model.requests)).not.toContain(f.input.token);
});

test("Cloud v2 page updates, comments, properties and tasks use deployment-specific payloads", async () => {
  const f = await setup();
  await f.connections.save({
    url: "https://fixture.atlassian.net/wiki",
    deployment: "cloud",
    email: "fixture@example.com",
    token: "cloud-secret",
    tokenType: "classic",
  });
  const calls: { path: string; method: string; body: any }[] = [];
  let pageVersion = 3;
  let taskStatus = "incomplete";
  const fetcher = (async (url: any, init: any) => {
    const path = new URL(url).pathname;
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method, body });
    const json = (value: any) =>
      new Response(JSON.stringify(value), {
        headers: { "content-type": "application/json" },
      });
    if (path === "/wiki/api/v2/pages/1") {
      if (method === "PUT") {
        expect(body.version.number).toBe(pageVersion + 1);
        expect(body.body.representation).toBe("storage");
        pageVersion++;
      }
      return json({
        id: "1",
        title: "Guide",
        spaceId: "5",
        status: "current",
        version: { number: pageVersion },
        body: { storage: { value: "<p>Node 22</p>" } },
        _links: { webui: "/spaces/ENG/pages/1" },
      });
    }
    if (path === "/wiki/api/v2/footer-comments")
      return json({ id: "90", version: { number: 1 } });
    if (path === "/wiki/api/v2/pages/1/properties")
      return json({
        results: [
          { id: "12", key: "custom", value: "old", version: { number: 1 } },
        ],
      });
    if (path === "/wiki/api/v2/pages/1/properties/12")
      return json({ id: "12", value: body.value, version: body.version });
    if (path === "/wiki/api/v2/tasks/30") {
      if (method === "PUT") taskStatus = body.status;
      return json({
        id: "30",
        status: taskStatus,
        updatedAt: "2026-09-13T00:00:00Z",
      });
    }
    return new Response("{}", {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const service = new ConfluenceService(f.connections, f.artifacts, fetcher);
  const tools = service.tools("cloud-session", () => "run");
  const call = async (a: object, write = false) => {
    const r = await tools[write ? 1 : 0].execute(
      "t",
      { request: a },
      undefined,
      undefined,
      {} as any,
    );
    return JSON.parse((r.content[0] as { text: string }).text);
  };
  expect((await call({ operation: "read_page", page: "1" })).version).toBe(3);
  expect(
    (
      await call(
        {
          operation: "append_page",
          page: "1",
          expectedVersion: 3,
          content: "More",
        },
        true,
      )
    ).status,
  ).toBe("success");
  expect(
    (
      await call(
        { operation: "add_comment", page: "1", content: "Hello" },
        true,
      )
    ).id,
  ).toBe("90");
  expect(
    calls.find((c) => c.path.endsWith("footer-comments"))?.body,
  ).toMatchObject({ pageId: "1", body: { representation: "storage" } });
  expect(
    (
      await call(
        {
          operation: "set_property",
          page: "1",
          key: "custom",
          value: "new",
          expectedVersion: 1,
        },
        true,
      )
    ).status,
  ).toBe("success");
  expect(
    (
      await call(
        {
          operation: "set_task_status",
          taskId: "30",
          expectedStatus: "incomplete",
          status: "complete",
        },
        true,
      )
    ).status,
  ).toBe("success");
  expect(taskStatus).toBe("complete");
});
