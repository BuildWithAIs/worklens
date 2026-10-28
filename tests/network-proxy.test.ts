import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { connect, type AddressInfo } from "node:net";
import type { ProxyConfig } from "electron";
import type { LookupAddress } from "node:dns";
import { NetworkProxy, readShellProxy } from "../src/main/network-proxy";
import {
  bypassesProxy,
  normalizeProxyUrl,
  parseProxyRule,
  proxyBypassList,
} from "../src/shared/network-proxy";

const tunnels: string[] = [];
let openssl = true;
try {
  execFileSync("openssl", ["version"], { stdio: "ignore" });
} catch {
  openssl = false;
}
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

test("CIDR-resolved domains connect directly using matching addresses and original Host", async () => {
  const resolveAddresses = vi.fn(async () => [
    { address: "192.0.2.1", family: 4 },
    { address: "127.0.0.1", family: 4 },
  ]);
  service = new NetworkProxy({
    resolveSystem: async () => "DIRECT",
    setSessionProxy: async () => {},
    resolveAddresses,
  });
  await service.apply({ mode: "custom", url: proxyUrl, bypass: "127.0.0.0/8" });
  const url = `http://connector.example.test:${port(target)}/`;
  expect(await (await fetch(url)).text()).toBe(
    `ok:connector.example.test:${port(target)}`,
  );
  expect(tunnels).toEqual([]);
  expect(resolveAddresses).toHaveBeenCalledTimes(1);

  // Removing the bypass immediately routes the same origin through the proxy.
  await service.apply({ mode: "custom", url: proxyUrl });
  expect(await (await fetch(url)).text()).toBe(
    `ok:connector.example.test:${port(target)}`,
  );
  expect(tunnels).toEqual([`connector.example.test:${port(target)}`]);
});

test("DNS failures still reach domains available only through the proxy", async () => {
  service = new NetworkProxy({
    resolveSystem: async () => "DIRECT",
    setSessionProxy: async () => {},
    resolveAddresses: async () => {
      throw new Error("Synthetic DNS failure");
    },
  });
  await service.apply({ mode: "custom", url: proxyUrl, bypass: "160.0.0.0/8" });
  expect(await (await fetch("http://connector.example.test/")).text()).toBe(
    "ok:connector.example.test",
  );
  expect(tunnels).toEqual(["connector.example.test:80"]);
});

test.skipIf(!openssl)(
  "CIDR direct HTTPS preserves SNI and verifies the original domain",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "worklens-proxy-tls-"));
    const original = tls.getCACertificates("default");
    let secure: Server | undefined;
    try {
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "ec",
          "-pkeyopt",
          "ec_paramgen_curve:prime256v1",
          "-nodes",
          "-keyout",
          join(dir, "key.pem"),
          "-out",
          join(dir, "cert.pem"),
          "-days",
          "1",
          "-subj",
          "/CN=connector.example.test",
          "-addext",
          "subjectAltName=DNS:connector.example.test",
        ],
        { stdio: "ignore" },
      );
      const cert = await readFile(join(dir, "cert.pem"), "utf8");
      tls.setDefaultCACertificates([...original, cert]);
      const servernames: string[] = [];
      const context = tls.createSecureContext({
        key: await readFile(join(dir, "key.pem")),
        cert,
      });
      secure = createHttpsServer(
        {
          key: await readFile(join(dir, "key.pem")),
          cert,
          SNICallback: (hostname, callback) => {
            servernames.push(hostname);
            callback(null, context);
          },
        },
        (request, response) => response.end(`ok:${request.headers.host}`),
      );
      await new Promise<void>((done) => secure!.listen(0, "127.0.0.1", done));
      service = new NetworkProxy({
        resolveSystem: async () => "DIRECT",
        setSessionProxy: async () => {},
        resolveAddresses: async () => [{ address: "127.0.0.1", family: 4 }],
      });
      await service.apply({
        mode: "custom",
        url: proxyUrl,
        bypass: "127.0.0.0/8",
      });
      expect(
        await (
          await fetch(`https://connector.example.test:${port(secure)}/`)
        ).text(),
      ).toBe(`ok:connector.example.test:${port(secure)}`);
      await expect(
        fetch(`https://wrong.example.test:${port(secure)}/`),
      ).rejects.toMatchObject({
        cause: { code: "ERR_TLS_CERT_ALTNAME_INVALID" },
      });
      expect(servernames).toEqual([
        "connector.example.test",
        "wrong.example.test",
      ]);
      expect(tunnels).toEqual([]);
    } finally {
      await service?.dispose();
      service = undefined;
      tls.setDefaultCACertificates(original);
      await new Promise<void>((done) =>
        secure ? secure.close(() => done()) : done(),
      );
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test.skipIf(!openssl)(
  "HTTPS proxies omit IP SNI, preserve domain SNI, and still verify proxy certificates",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "worklens-proxy-ip-tls-"));
    const original = tls.getCACertificates("default");
    const servers: Server[] = [];
    const names: string[] = [];
    try {
      const credentials = async (name: string, alternative: string) => {
        execFileSync(
          "openssl",
          [
            "req",
            "-x509",
            "-newkey",
            "ec",
            "-pkeyopt",
            "ec_paramgen_curve:prime256v1",
            "-nodes",
            "-keyout",
            join(dir, `${name}-key.pem`),
            "-out",
            join(dir, `${name}-cert.pem`),
            "-days",
            "1",
            "-subj",
            `/CN=${name}`,
            "-addext",
            `subjectAltName=${alternative}`,
          ],
          { stdio: "ignore" },
        );
        return {
          key: await readFile(join(dir, `${name}-key.pem`)),
          cert: await readFile(join(dir, `${name}-cert.pem`), "utf8"),
        };
      };
      const valid = await credentials("proxy", "IP:127.0.0.1,DNS:localhost");
      const mismatch = await credentials("wrong-proxy", "DNS:wrong.proxy.test");
      tls.setDefaultCACertificates([...original, valid.cert, mismatch.cert]);
      const proxy = async (credentials: typeof valid) => {
        const server = createHttpsServer(credentials);
        servers.push(server);
        server.on("secureConnection", (socket) => {
          names.push(socket.servername || "");
        });
        server.on("connect", (_request, socket, head) => {
          const upstream = connect(port(target), "127.0.0.1", () => {
            socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            upstream.write(head);
            upstream.pipe(socket);
            socket.pipe(upstream);
          });
          upstream.on("error", () => socket.destroy());
          socket.on("error", () => upstream.destroy());
        });
        await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
        return port(server);
      };
      const validPort = await proxy(valid);
      const invalidPort = await proxy(mismatch);
      service = new NetworkProxy({
        resolveSystem: async () => "DIRECT",
        setSessionProxy: async () => {},
      });
      for (const [host, name] of [
        ["127.0.0.1", ""],
        ["localhost", "localhost"],
      ]) {
        await service.apply({
          mode: "custom",
          url: `https://${host}:${validPort}`,
        });
        expect(await (await fetch("http://behind.example.test/")).text()).toBe(
          "ok:behind.example.test",
        );
        expect(names.at(-1)).toBe(name);
        expect(service.status()).toMatchObject({ proxy: false });
      }
      // Trust alone must not allow a certificate issued for the wrong host.
      await service.apply({
        mode: "custom",
        url: `https://127.0.0.1:${invalidPort}`,
      });
      await expect(fetch("http://behind.example.test/")).rejects.toMatchObject({
        cause: { code: "UND_ERR_PRX_TLS" },
      });
      expect(service.status()).toMatchObject({ proxy: true });
    } finally {
      await service?.dispose();
      service = undefined;
      tls.setDefaultCACertificates(original);
      for (const server of servers)
        await new Promise<void>((done) => server.close(() => done()));
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("aborted requests do not open a tunnel after pending DNS completes", async () => {
  let complete!: (addresses: LookupAddress[]) => void;
  let started!: () => void;
  const ready = new Promise<void>((done) => {
    started = done;
  });
  service = new NetworkProxy({
    resolveSystem: async () => "DIRECT",
    setSessionProxy: async () => {},
    resolveAddresses: () =>
      new Promise((done) => {
        complete = done;
        started();
      }),
  });
  await service.apply({ mode: "custom", url: proxyUrl, bypass: "160.0.0.0/8" });
  const abort = new AbortController();
  const request = fetch("http://connector.example.test/", {
    signal: abort.signal,
  });
  const rejected = expect(request).rejects.toMatchObject({
    name: "AbortError",
  });
  await ready;
  abort.abort();
  complete([]);
  await rejected;
  await new Promise((done) => setTimeout(done, 50));
  expect(tunnels).toEqual([]);
});

test("pending requests follow changed settings after DNS completes", async () => {
  let complete!: (addresses: LookupAddress[]) => void;
  let started!: () => void;
  const ready = new Promise<void>((done) => {
    started = done;
  });
  service = new NetworkProxy({
    resolveSystem: async () => "DIRECT",
    setSessionProxy: async () => {},
    resolveAddresses: () =>
      new Promise((done) => {
        complete = done;
        started();
      }),
  });
  await service.apply({ mode: "custom", url: proxyUrl, bypass: "127.0.0.0/8" });
  const request = fetch(`http://connector.example.test:${port(target)}/`);
  await ready;
  await service.apply({ mode: "custom", url: proxyUrl });
  complete([{ address: "127.0.0.1", family: 4 }]);
  expect(await (await request).text()).toBe(
    `ok:connector.example.test:${port(target)}`,
  );
  expect(tunnels).toEqual([`connector.example.test:${port(target)}`]);
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
  // A test of an unsaved draft never changes the current configuration's status.
  expect(service.status()).toMatchObject({ proxy: false, bypass: false });
});

test.skipIf(!openssl)(
  "a destination's certificate is not the proxy's failure, but the proxy's own is",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "worklens-proxy-stage-"));
    const servers: Server[] = [];
    const listen = async (server: Server) => {
      servers.push(server);
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      return port(server);
    };
    // Tunnels every CONNECT to `destination`, like a working proxy.
    const tunnel = (server: Server, destination: () => number) =>
      server.on("connect", (_request, socket, head) => {
        const upstream = connect(destination(), "127.0.0.1", () => {
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          upstream.write(head);
          upstream.pipe(socket);
          socket.pipe(upstream);
        });
        upstream.on("error", () => socket.destroy());
        socket.on("error", () => upstream.destroy());
      });
    try {
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "ec",
          "-pkeyopt",
          "ec_paramgen_curve:prime256v1",
          "-nodes",
          "-keyout",
          join(dir, "key.pem"),
          "-out",
          join(dir, "cert.pem"),
          "-days",
          "1",
          "-subj",
          "/CN=untrusted.example.test",
        ],
        { stdio: "ignore" },
      );
      const credentials = {
        key: await readFile(join(dir, "key.pem")),
        cert: await readFile(join(dir, "cert.pem")),
      };
      let securePort = 0;
      securePort = await listen(
        createHttpsServer(credentials, (_request, response) =>
          response.end("ok"),
        ),
      );
      const plainProxy = await listen(tunnel(createServer(), () => securePort));
      const secureProxy = await listen(
        tunnel(createHttpsServer(credentials), () => port(target)),
      );
      service = new NetworkProxy({
        resolveSystem: async () => "DIRECT",
        setSessionProxy: async () => {},
      });
      await service.apply({
        mode: "custom",
        url: `http://127.0.0.1:${plainProxy}`,
      });
      await expect(
        fetch("https://untrusted.example.test/"),
      ).rejects.toMatchObject({
        cause: { code: "DEPTH_ZERO_SELF_SIGNED_CERT" },
      });
      expect(service.status()).toMatchObject({ proxy: false });

      await service.apply({
        mode: "custom",
        url: `https://127.0.0.1:${secureProxy}`,
      });
      await expect(fetch("http://behind.example.test/")).rejects.toThrow();
      expect(service.status()).toMatchObject({ proxy: true });
    } finally {
      await service?.dispose();
      service = undefined;
      for (const server of servers)
        await new Promise<void>((done) => server.close(() => done()));
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("a rejected proxy tunnel updates runtime status and the same origin can recover", async () => {
  let rejectTunnel = true;
  const unstable = createServer();
  unstable.on("connect", (_request, socket, head) => {
    if (rejectTunnel) {
      socket.end(
        "HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n",
      );
      return;
    }
    const upstream = connect(port(target), "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  await new Promise<void>((done) => unstable.listen(0, "127.0.0.1", done));
  const changed = vi.fn();
  try {
    service = new NetworkProxy({
      resolveSystem: async () => "DIRECT",
      setSessionProxy: async () => {},
      onStatus: changed,
    });
    await service.apply({
      mode: "custom",
      url: `http://127.0.0.1:${port(unstable)}`,
    });
    await expect(fetch("http://unstable.example.test/")).rejects.toThrow();
    expect(service.status()).toMatchObject({ proxy: true, bypass: false });
    expect(changed).toHaveBeenCalledTimes(1);
    rejectTunnel = false;
    expect(await (await fetch("http://unstable.example.test/")).text()).toBe(
      "ok:unstable.example.test",
    );
    expect(service.status()).toMatchObject({ proxy: false, bypass: false });
    expect(changed).toHaveBeenCalledTimes(2);
  } finally {
    await service?.dispose();
    service = undefined;
    await new Promise((done) => unstable.close(done));
  }
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
