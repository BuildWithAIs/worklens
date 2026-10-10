import { afterEach, expect, test } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { McpService } from "../src/main/mcp-service";
import { installationId } from "../src/main/installation-id";
import { schemas } from "../src/main/validation";
import { requiredMcpCredentials } from "../src/renderer/src/components/worklens/mcp-configuration";
import { availableMcpName } from "../src/renderer/src/components/worklens/mcp-presets";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const encryption = {
  isEncryptionAvailable: () => true,
  encryptString: (text: string) =>
    Buffer.from(Buffer.from(text).map((value) => value ^ 0x7f)),
  decryptString: (data: Buffer) =>
    Buffer.from(data.map((value) => value ^ 0x7f)).toString(),
};
const fixture = {
  command: process.execPath,
  args: [resolve("tests/fixtures/mcp-server.mjs")],
};
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "worklens-mcp-"));
  const service = new McpService(directory, encryption);
  service.initialize();
  cleanup.push(() => service.shutdown());
  return { directory, service };
}

test("generated MCP keys remain unique and valid for repeated 80-character display names", () => {
  const label = "a".repeat(80);
  const keys = [label];
  for (let index = 0; index < 3; index++) {
    const key = availableMcpName(label, keys);
    expect(key).toMatch(/^[a-zA-Z0-9_-]{1,80}$/);
    expect(keys).not.toContain(key);
    keys.push(key);
  }
  expect(availableMcpName("same-name", ["same_name", "same_name_2"])).toBe(
    "same-name-3",
  );
});

test("MCP display-name edits survive restart and preserve server keys and masked credentials", async () => {
  const { service, directory } = await setup();
  service.save(
    JSON.stringify({
      mcpServers: {
        stable: {
          ...fixture,
          displayName: "Paper trail",
          env: { TOKEN: "synthetic-label-secret" },
        },
        legacy: {
          url: "https://example.invalid/mcp",
          headers: { Authorization: "Bearer synthetic-remote" },
        },
      },
    }),
  );
  expect(
    JSON.parse(service.snapshot().config).mcpServers.legacy,
  ).not.toHaveProperty("displayName");
  const next = JSON.parse(service.snapshot().config);
  next.mcpServers.stable.displayName = "项目笔记";
  service.save(JSON.stringify(next));
  expect(Object.keys(JSON.parse(service.snapshot().config).mcpServers)).toEqual(
    ["stable", "legacy"],
  );
  expect(service.snapshot().servers[0].name).toBe("stable");
  expect(JSON.parse(service.snapshot().config).mcpServers.stable).toMatchObject(
    { displayName: "项目笔记" },
  );
  const restarted = new McpService(directory, encryption);
  restarted.initialize();
  cleanup.push(() => restarted.shutdown());
  expect(restarted.snapshot()).toEqual(service.snapshot());
  expect(
    JSON.parse(restarted.snapshot().config).mcpServers.stable.env.TOKEN,
  ).toBe("<saved>");
  expect(
    await readFile(join(directory, "mcp-settings.json"), "utf8"),
  ).not.toContain("synthetic-label-secret");
  const runtime = await ModelRuntime.create({
    modelsPath: null,
    authPath: join(directory, "auth.json"),
    refreshOnCreate: false,
  });
  expect(await restarted.test("stable", directory, runtime)).toEqual({
    tools: 3,
  });
  for (const displayName of ["", " ", "a".repeat(81)]) {
    const invalid = structuredClone(next);
    invalid.mcpServers.stable.displayName = displayName;
    expect(() => service.save(JSON.stringify(invalid))).toThrow(
      "Invalid MCP configuration",
    );
    expect(
      JSON.parse(service.snapshot().config).mcpServers.stable.displayName,
    ).toBe("项目笔记");
  }
});

test("MCP editor credential checks match service rules for remote and local target changes", async () => {
  const { service } = await setup();
  service.save(
    JSON.stringify({
      mcpServers: {
        remote: {
          url: "https://example.invalid/mcp",
          headers: {
            Authorization: "Bearer synthetic",
            "X-Workspace": "synthetic",
          },
          oauth: { clientId: "client", clientSecret: "synthetic" },
        },
        local: {
          command: "node",
          args: ["server.mjs"],
          cwd: "/tmp",
          env: { TOKEN: "synthetic" },
        },
      },
    }),
  );
  const original = JSON.parse(service.snapshot().config);
  const cases = [
    {
      name: "remote",
      patch: { url: "https://example.invalid/new" },
      fields: [
        "headers.Authorization",
        "headers.X-Workspace",
        "oauth.clientSecret",
      ],
    },
    {
      name: "remote",
      patch: { oauth: { clientId: "other", clientSecret: "<saved>" } },
      fields: ["oauth.clientSecret"],
    },
    { name: "local", patch: { args: ["other.mjs"] }, fields: ["env.TOKEN"] },
    { name: "local", patch: { cwd: "/tmp/other" }, fields: ["env.TOKEN"] },
  ];
  for (const { name, patch, fields } of cases) {
    const next = structuredClone(original);
    Object.assign(next.mcpServers[name], patch);
    expect(
      requiredMcpCredentials(next.mcpServers[name], original.mcpServers[name]),
    ).toEqual(fields);
    expect(() => service.save(JSON.stringify(next))).toThrow(/Re-enter/);
  }
  const unchanged = structuredClone(original);
  unchanged.mcpServers.remote.url = "https://example.invalid:443/mcp";
  expect(
    requiredMcpCredentials(
      unchanged.mcpServers.remote,
      original.mcpServers.remote,
    ),
  ).toEqual([]);
  expect(() => service.save(JSON.stringify(unchanged))).not.toThrow();
  const replaced = structuredClone(original);
  replaced.mcpServers.remote.url = "https://example.invalid/new";
  replaced.mcpServers.remote.headers = {
    Authorization: "Bearer synthetic-new",
    "X-Workspace": "synthetic-new",
  };
  replaced.mcpServers.remote.oauth.clientSecret = "synthetic-new";
  expect(
    requiredMcpCredentials(
      replaced.mcpServers.remote,
      original.mcpServers.remote,
    ),
  ).toEqual([]);
  expect(() => service.save(JSON.stringify(replaced))).not.toThrow();
});

test("MCP settings encrypt secrets, mask the editor and restore only for the same target", async () => {
  const { directory, service } = await setup();
  const secret = 'private-"quoted"-\\token\nnext';
  service.save(
    JSON.stringify({
      mcpServers: {
        local: { ...fixture, env: { TOKEN: secret } },
        remote: {
          url: "https://example.invalid/mcp",
          headers: { Authorization: "Bearer remote-token" },
        },
      },
    }),
  );
  const snapshot = service.snapshot();
  expect(snapshot.config).not.toContain("private");
  expect(snapshot.config).not.toContain("remote-token");
  expect(snapshot.config).toContain("<saved>");
  expect(
    snapshot.servers.find((server) => server.name === "remote")?.oauth,
  ).toBe(false);
  expect(
    await readFile(join(directory, "mcp-settings.json"), "utf8"),
  ).not.toContain("private");
  const next = JSON.parse(snapshot.config);
  next.mcpServers.local.enabled = false;
  service.save(JSON.stringify(next));
  const reopened = new McpService(directory, encryption);
  reopened.initialize();
  expect(reopened.snapshot().servers[0].enabled).toBe(false);
  expect(reopened.redact(JSON.stringify({ secret }))).toBe(
    '{"secret":"[redacted]"}',
  );
  next.mcpServers.remote.url = "https://other.invalid/mcp";
  expect(() => service.save(JSON.stringify(next))).toThrow(
    "Re-enter credentials",
  );
  expect(() =>
    service.save(
      '{"mcpServers":{"same-name":{"command":"node"},"same_name":{"command":"node"}}}',
    ),
  ).toThrow("Invalid MCP configuration");
  expect(() =>
    service.save('{"mcpServers":{"bad":{"url":"http://example.com/mcp"}}}'),
  ).toThrow("Invalid MCP configuration");
  expect(
    schemas.mcpSave.safeParse({ config: "{}", command: "arbitrary" }).success,
  ).toBe(false);
});

test("stdio test connects, lists tools, and closes the child process", async () => {
  const { service, directory } = await setup();
  service.save(JSON.stringify({ mcpServers: { fixture } }));
  const runtime = await ModelRuntime.create({
    modelsPath: null,
    authPath: join(directory, "auth.json"),
    refreshOnCreate: false,
  });
  expect(await service.test("fixture", directory, runtime)).toEqual({
    tools: 3,
  });
  await service.shutdown();
});

test("connection test accepts a resource-only MCP server without listing tools", async () => {
  const { service, directory } = await setup();
  service.save(
    JSON.stringify({
      mcpServers: {
        fixture: {
          ...fixture,
          args: [...fixture.args, "--resources-only"],
        },
      },
    }),
  );
  const runtime = await ModelRuntime.create({
    modelsPath: null,
    authPath: join(directory, "auth.json"),
    refreshOnCreate: false,
  });
  expect(await service.test("fixture", directory, runtime)).toEqual({
    tools: 0,
  });
});

test("unavailable or corrupt secure storage cannot expose plaintext or prevent startup", async () => {
  const { directory } = await setup();
  const unavailable = new McpService(directory, {
    ...encryption,
    isEncryptionAvailable: () => false,
  });
  expect(() =>
    unavailable.save(JSON.stringify({ mcpServers: { fixture } })),
  ).toThrow("Secure storage");
  await writeFile(join(directory, "mcp-settings.json"), "{broken");
  unavailable.initialize();
  expect(unavailable.snapshot().servers).toEqual([]);
  expect(unavailable.snapshot().error).toContain("secure storage");
  await mkdir(join(directory, "identity"));
  const path = join(directory, "identity", "installation-id");
  const first = installationId(path)();
  expect(installationId(path)()).toBe(first);
  expect(first).toMatch(/^[0-9a-f-]{36}$/);
  await writeFile(path, "invalid");
  expect(() => installationId(path)()).toThrow("Invalid installation ID");
});

test("MCP browser OAuth validates callback state, encrypts tokens and allows HTTP tool discovery", async () => {
  const { directory } = await setup();
  let base = "";
  let callbacks = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, base);
    let body = "";
    for await (const chunk of request) body += chunk;
    const json = (value: unknown, status = 200) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (url.pathname.includes("oauth-protected-resource"))
      return json({ resource: base + "/mcp", authorization_servers: [base] });
    if (
      url.pathname.includes("oauth-authorization-server") ||
      url.pathname.includes("openid-configuration")
    )
      return json({
        issuer: base,
        authorization_endpoint: base + "/authorize",
        token_endpoint: base + "/token",
        registration_endpoint: base + "/register",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    if (url.pathname === "/register")
      return json({ ...JSON.parse(body), client_id: "fixture-client" }, 201);
    if (url.pathname === "/token")
      return json({
        access_token: "private-mcp-access",
        refresh_token: "private-mcp-refresh",
        token_type: "Bearer",
        expires_in: 3600,
      });
    if (url.pathname === "/mcp") {
      if (request.headers.authorization !== "Bearer private-mcp-access") {
        response.setHeader(
          "www-authenticate",
          `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
        );
        return json({}, 401);
      }
      if (request.method === "GET") {
        response.writeHead(405);
        return response.end();
      }
      const input = JSON.parse(body);
      if (input.id === undefined) {
        response.writeHead(202);
        return response.end();
      }
      const result =
        input.method === "initialize"
          ? {
              protocolVersion: input.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "http-fixture", version: "1" },
            }
          : { tools: [] };
      return json({ jsonrpc: "2.0", id: input.id, result });
    }
    return json({}, 404);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  const service = new McpService(
    directory,
    encryption,
    () => {},
    async (authorization) => {
      const url = new URL(authorization);
      const callback = new URL(url.searchParams.get("redirect_uri")!);
      callback.searchParams.set("code", "fixture-code");
      callback.searchParams.set("state", "wrong-state");
      expect((await fetch(callback)).status).toBe(400);
      callback.searchParams.set("state", url.searchParams.get("state")!);
      expect((await fetch(callback)).status).toBe(200);
      callbacks++;
    },
  );
  cleanup.push(() => service.shutdown());
  service.initialize();
  service.save(
    JSON.stringify({ mcpServers: { remote: { url: base + "/mcp" } } }),
  );
  await service.login("remote", "oauth-test");
  expect(callbacks).toBe(1);
  expect(service.snapshot().servers[0].signedIn).toBe(true);
  expect(
    await readFile(join(directory, "mcp-credentials.json"), "utf8"),
  ).not.toContain("private-mcp");
  expect(service.redact(base + " private-mcp-access private-mcp-refresh")).toBe(
    base + " [redacted] [redacted]",
  );
  const runtime = await ModelRuntime.create({
    modelsPath: null,
    authPath: join(directory, "auth.json"),
    refreshOnCreate: false,
  });
  expect(await service.test("remote", directory, runtime)).toEqual({
    tools: 0,
  });
  expect((await service.logout("remote")).servers[0].signedIn).toBe(false);
});
