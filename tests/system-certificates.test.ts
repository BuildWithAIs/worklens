import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { Agent, fetch as undiciFetch } from "undici";
import { afterEach, expect, test } from "vitest";
import { trustSystemCertificates } from "../src/main/system-certificates";

const bundled = ["bundled-root-a", "bundled-root-b"];
function fakeApi(system: string[] | Error) {
  const calls: string[][] = [];
  return {
    calls,
    api: {
      getCACertificates: (type?: string) => {
        if (type === "system" && system instanceof Error) throw system;
        return type === "system" ? (system as string[]) : bundled;
      },
      setDefaultCACertificates: (certs: readonly unknown[]) => {
        calls.push([...certs] as string[]);
      },
    } as Parameters<typeof trustSystemCertificates>[0],
  };
}

test("adds only system roots that Node does not already trust", () => {
  const { api, calls } = fakeApi(["bundled-root-b", "enterprise-root"]);
  const env: NodeJS.ProcessEnv = {};
  expect(trustSystemCertificates(api, env)).toBe(1);
  expect(calls).toEqual([[...bundled, "enterprise-root"]]);
  // Node-based child processes such as local MCP servers inherit it.
  expect(env.NODE_USE_SYSTEM_CA).toBe("1");
});

test("leaves the defaults alone when the system adds nothing new", () => {
  const { api, calls } = fakeApi(["bundled-root-a"]);
  expect(trustSystemCertificates(api, {})).toBe(0);
  expect(calls).toEqual([]);
});

test("NODE_USE_SYSTEM_CA=0 opts out for the app and its child processes", () => {
  const { api, calls } = fakeApi(["enterprise-root"]);
  const env: NodeJS.ProcessEnv = { NODE_USE_SYSTEM_CA: "0" };
  expect(trustSystemCertificates(api, env)).toBe(0);
  expect(calls).toEqual([]);
  expect(env.NODE_USE_SYSTEM_CA).toBe("0");
});

test("an unreadable system store never blocks startup", () => {
  const { api, calls } = fakeApi(new Error("keychain unavailable"));
  expect(trustSystemCertificates(api, {})).toBe(0);
  expect(calls).toEqual([]);
});

const restore: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const fn of restore.splice(0).reverse()) await fn();
});
let openssl = true;
try {
  execFileSync("openssl", ["version"], { stdio: "ignore" });
} catch {
  openssl = false;
}

test.skipIf(!openssl)(
  "fetch reaches a site signed by a root that only the system trusts",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "worklens-system-ca-"));
    restore.push(() => rm(dir, { recursive: true, force: true }));
    // A synthetic stand-in for an enterprise CA; generated, never committed.
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
        "/CN=WorkLens test enterprise CA",
        "-addext",
        "subjectAltName=DNS:localhost",
      ],
      { stdio: "ignore" },
    );
    const cert = await readFile(join(dir, "cert.pem"), "utf8");
    const server = createServer(
      { key: await readFile(join(dir, "key.pem")), cert },
      (_request, response) => response.end("trusted"),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    restore.push(() => new Promise((resolve) => server.close(resolve)));
    const url = `https://localhost:${(server.address() as AddressInfo).port}/`;
    const request = () => undiciFetch(url, { dispatcher: new Agent() });
    const original = tls.getCACertificates("default");
    restore.push(() => tls.setDefaultCACertificates(original));

    await expect(request()).rejects.toThrow();
    const added = trustSystemCertificates(
      {
        getCACertificates: (type) =>
          // The same root twice, with different line endings, counts once.
          type === "system"
            ? [cert, cert.replace(/\n/g, "\r\n")]
            : tls.getCACertificates(type),
        setDefaultCACertificates: tls.setDefaultCACertificates,
      },
      {},
    );
    expect(added).toBe(1);
    expect(await (await request()).text()).toBe("trusted");
  },
);
