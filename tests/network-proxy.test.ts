import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import type { ProxyConfig } from "electron";
import { NetworkProxy, readShellProxy } from "../src/main/network-proxy";
import {
  bypassesProxy,
  normalizeProxyUrl,
  parseProxyRule,
  proxyBypassList,
} from "../src/shared/network-proxy";

const tunnels: string[] = [];
let target: Server;
let proxyServer: Server;
let proxyUrl: string;
let service: NetworkProxy | undefined;
const PROXY_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
];
// Tests must not depend on, or change, the developer's own proxy variables.
const launchEnv = Object.fromEntries(
  PROXY_KEYS.map((key) => [key, process.env[key]]),
);
function resetEnvironment() {
  for (const key of PROXY_KEYS) delete process.env[key];
}

function port(server: Server) {
  return (server.address() as AddressInfo).port;
}

beforeAll(async () => {
  resetEnvironment();
  target = createServer((request, response) =>
    response.end(`ok:${request.headers.host}`),
  );
  // Tunnels every CONNECT to the local target, whatever host was requested,
  // so a fake hostname only resolves when the request used the proxy.
  proxyServer = createServer();
  proxyServer.on("connect", (request, socket, head) => {
    tunnels.push(request.url ?? "");
    const upstream = connect(port(target), "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) =>
    proxyServer.listen(0, "127.0.0.1", resolve),
  );
  proxyUrl = `http://127.0.0.1:${port(proxyServer)}`;
});

afterEach(async () => {
  await service?.dispose();
  service = undefined;
  tunnels.length = 0;
  resetEnvironment();
});

afterAll(async () => {
  for (const [key, value] of Object.entries(launchEnv))
    if (value !== undefined) process.env[key] = value;
  await new Promise((resolve) => target.close(resolve));
  await new Promise((resolve) => proxyServer.close(resolve));
});

test("proxy addresses, PAC results and bypass entries parse like the settings UI", () => {
  expect(normalizeProxyUrl("127.0.0.1:7890")).toBe("http://127.0.0.1:7890");
  expect(normalizeProxyUrl(" https://proxy.example:8443/ ")).toBe(
    "https://proxy.example:8443",
  );
  for (const invalid of [
    "",
    "socks5://127.0.0.1:7891",
    "http://user:pass@127.0.0.1:7890",
    "http://127.0.0.1:7890/path",
    "http://127.0.0.1:7890?x=1",
  ])
    expect(normalizeProxyUrl(invalid)).toBeUndefined();

  expect(parseProxyRule("PROXY 127.0.0.1:7890; DIRECT")).toEqual({
    proxy: "http://127.0.0.1:7890",
  });
  expect(parseProxyRule("HTTPS proxy.example:443")).toEqual({
    proxy: "https://proxy.example",
  });
  expect(parseProxyRule("DIRECT")).toEqual({});
  expect(parseProxyRule("SOCKS5 127.0.0.1:7891; DIRECT")).toEqual({
    unsupported: "SOCKS5 127.0.0.1:7891",
  });
  expect(parseProxyRule("SOCKS5 127.0.0.1:7891; PROXY 127.0.0.1:7890")).toEqual(
    { proxy: "http://127.0.0.1:7890" },
  );

  const list = proxyBypassList("internal.test, *.corp.example\n.lan");
  expect(list).toEqual([
    "localhost",
    "127.0.0.1",
    "::1",
    "internal.test",
    "*.corp.example",
    ".lan",
  ]);
  for (const host of [
    "localhost",
    "127.0.0.2",
    "[::1]",
    "internal.test",
    "api.internal.test",
    "git.corp.example",
    "printer.lan",
  ])
    expect(bypassesProxy(host, list)).toBe(true);
  expect(bypassesProxy("api.openai.com", list)).toBe(false);
});

test("a custom proxy routes main-process fetch, sessions and child-process environment", async () => {
  const sessions: ProxyConfig[] = [];
  service = new NetworkProxy({
    resolveSystem: async () => "DIRECT",
    setSessionProxy: async (config) => {
      sessions.push(config);
    },
  });
  await service.apply({
    mode: "custom",
    url: proxyUrl.replace("http://", ""),
    bypass: "internal.test",
  });

  const response = await fetch("http://worklens.test/hello");
  expect(await response.text()).toBe("ok:worklens.test");
  expect(tunnels).toEqual(["worklens.test:80"]);
  expect(sessions.at(-1)).toEqual({
    mode: "fixed_servers",
    proxyRules: proxyUrl,
    proxyBypassRules: "localhost,127.0.0.1,::1,internal.test",
  });
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"])
    expect(process.env[key]).toBe(proxyUrl);
  expect(process.env.NO_PROXY).toBe("localhost,127.0.0.1,::1,internal.test");

  // Local services and bypassed hosts connect directly.
  const local = await fetch(`http://127.0.0.1:${port(target)}/`);
  expect(await local.text()).toBe(`ok:127.0.0.1:${port(target)}`);
  await expect(fetch("http://internal.test/")).rejects.toThrow();
  expect(tunnels).toEqual(["worklens.test:80"]);
});

test("system mode follows the operating system per request; off restores the launch environment", async () => {
  process.env.HTTPS_PROXY = "http://launch.example:8080";
  let rule = `PROXY ${proxyUrl.replace("http://", "")}; DIRECT`;
  const sessions: ProxyConfig[] = [];
  service = new NetworkProxy({
    resolveSystem: async () => rule,
    setSessionProxy: async (config) => {
      sessions.push(config);
    },
  });
  await service.apply({ mode: "system" });
  expect(sessions.at(-1)).toEqual({ mode: "system" });
  expect(await (await fetch("http://worklens.test/")).text()).toBe(
    "ok:worklens.test",
  );
  expect(process.env.HTTPS_PROXY).toBe(proxyUrl);

  rule = "DIRECT";
  await service.apply({ mode: "system" });
  await expect(fetch("http://worklens.test/")).rejects.toThrow();
  expect(tunnels).toEqual(["worklens.test:80"]);
  expect(process.env.HTTPS_PROXY).toBe("http://launch.example:8080");

  rule = `PROXY ${proxyUrl.replace("http://", "")}`;
  await service.apply({ mode: "off" });
  expect(sessions.at(-1)).toEqual({ mode: "direct" });
  await expect(fetch("http://worklens.test/")).rejects.toThrow();
  expect(tunnels).toEqual(["worklens.test:80"]);
  expect(process.env.HTTPS_PROXY).toBe("http://launch.example:8080");
});

test("detection reports unsupported system proxies and falls back to the login shell", async () => {
  const shells: NodeJS.ProcessEnv[] = [];
  service = new NetworkProxy({
    resolveSystem: async () => "SOCKS5 127.0.0.1:7891; DIRECT",
    setSessionProxy: async () => {},
    readShellProxy: async (env) => {
      shells.push(env);
      return "http://127.0.0.1:7890";
    },
  });
  await service.apply({ mode: "custom", url: proxyUrl });
  expect(await service.detect()).toEqual({
    unsupported: "SOCKS5 127.0.0.1:7891",
    environment: undefined,
    system: undefined,
  });
  expect(await service.detect(true)).toMatchObject({
    environment: "http://127.0.0.1:7890",
  });
  // The shell sees the launch environment, not the injected proxy.
  expect(shells[0].HTTPS_PROXY).toBeUndefined();
});

test("connection tests report the proxy that could not be reached", async () => {
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const unreachable = `http://127.0.0.1:${port(closed)}`;
  await new Promise((resolve) => closed.close(resolve));
  service = new NetworkProxy({
    resolveSystem: async () => "DIRECT",
    setSessionProxy: async () => {},
  });
  await expect(
    service.test({ mode: "custom", url: unreachable }),
  ).rejects.toThrow(`Could not reach the network through proxy ${unreachable}`);
});

test.skipIf(process.platform === "win32")(
  "login-shell detection reads exported proxy variables",
  async () => {
    expect(
      await readShellProxy({
        ...process.env,
        SHELL: "/bin/sh",
        HTTPS_PROXY: "127.0.0.1:7890",
      }),
    ).toBe("http://127.0.0.1:7890");
  },
);

test("an unreadable system proxy falls back to direct connections instead of failing startup", async () => {
  service = new NetworkProxy({
    resolveSystem: async () => {
      throw new Error("Proxy resolution unavailable");
    },
    setSessionProxy: async () => {},
  });
  await expect(service.apply({ mode: "system" })).resolves.toBeUndefined();
  expect(process.env.HTTPS_PROXY).toBeUndefined();
  const local = await fetch(`http://127.0.0.1:${port(target)}/`);
  expect(local.ok).toBe(true);
  await expect(fetch("http://worklens.test/")).rejects.toThrow();
  expect(tunnels).toEqual([]);
});
