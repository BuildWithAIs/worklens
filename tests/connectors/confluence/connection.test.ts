import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ConfluenceConnections } from "../../../src/main/connectors/confluence/connection";
import { testConnection } from "../../../src/main/connectors/confluence/connection-test";
import { ConfluenceService } from "../../../src/main/connectors/confluence/service";
import { certificateFailure } from "../../../src/main/connectors/confluence/http";
import { setup } from "./setup";

test("save validates automatically, failed replacement disables tools, and a corrected save re-enables them", async () => {
  const f = await setup();
  expect(f.fixture.requests.some((r) => r.path.endsWith("/user/current"))).toBe(
    true,
  );
  const old = f.connections.snapshot();
  f.fixture.state.identityStatus = 401;
  await expect(
    f.connections.save({ ...f.input, token: "invalid-secret" }),
  ).rejects.toThrow("401");
  expect(old.signal.aborted).toBe(true);
  expect(f.service.names()).toEqual([]);
  expect((await f.call({ operation: "current_user" })).result.isError).toBe(
    true,
  );
  const persisted = await readFile(join(f.root, "connection.json"), "utf8");
  expect(persisted).not.toContain("invalid-secret");
  expect(JSON.parse(persisted).settings.configured).toBe(false);
  const restarted = new ConfluenceConnections(
    join(f.root, "connection.json"),
    f.encryption,
  );
  await restarted.load();
  expect(restarted.info().configured).toBe(false);
  expect(() => restarted.snapshot()).toThrow();
  f.fixture.state.identityStatus = 200;
  await f.connections.save(f.input);
  expect(f.service.names()).toHaveLength(2);
});

test("startup revalidates formerly working credentials; anonymous and missing settings cannot enable tools", async () => {
  const f = await setup();
  f.fixture.state.anonymous = true;
  const restarted = new ConfluenceConnections(
    join(f.root, "connection.json"),
    f.encryption,
  );
  await restarted.load();
  expect(restarted.info().configured).toBe(false);
  await expect(f.connections.save(f.input)).rejects.toThrow("已登录用户");
  expect(f.service.names()).toEqual([]);
  await expect(f.connections.save({ ...f.input, url: "" })).rejects.toThrow();
  expect(f.service.names()).toEqual([]);
  const fresh = new ConfluenceConnections(
    join(f.root, "fresh.json"),
    f.encryption,
  );
  await expect(fresh.save({ ...f.input, token: "" })).rejects.toThrow("token");
  expect(fresh.info().configured).toBe(false);
});

test("Cloud scoped validation binds URL to Cloud ID before sending credentials to the gateway", async () => {
  const snapshot = {
    settings: {
      url: "https://fixture.atlassian.net/wiki",
      deployment: "cloud" as const,
      tokenType: "scoped" as const,
      cloudId: "expected",
      email: "fixture@example.com",
      configured: false,
    },
    token: "synthetic-token",
    revision: "test",
    signal: new AbortController().signal,
  };
  const calls: { url: string; headers: Headers }[] = [];
  let cloudId = "different";
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers) });
    return Response.json(
      String(url).endsWith("/_edge/tenant_info")
        ? { cloudId }
        : { accountId: "user1" },
    );
  };
  await expect(testConnection(snapshot, fetcher)).rejects.toThrow("不匹配");
  expect(calls).toHaveLength(1);
  expect(calls[0].headers.has("authorization")).toBe(false);
  cloudId = "expected";
  await expect(testConnection(snapshot, fetcher)).resolves.toContain("已连接");
  expect(calls.at(-1)?.url).toContain(
    "api.atlassian.com/ex/confluence/expected/wiki/",
  );
  expect(calls.at(-1)?.headers.get("authorization")).toContain("Basic ");
});

test.each(["html", "redirect", "network"])(
  "save fails closed on %s validation failures",
  async (mode) => {
    const f = await setup();
    const connections = new ConfluenceConnections(
      join(f.root, "candidate.json"),
      f.encryption,
      async () => {
        if (mode === "network") throw new Error("connection refused");
        if (mode === "redirect")
          return new Response(null, {
            status: 302,
            headers: { location: "https://login.example" },
          });
        return new Response("<html>Login</html>", {
          headers: { "content-type": "text/html" },
        });
      },
    );
    await expect(connections.save(f.input)).rejects.toThrow();
    expect(connections.info().configured).toBe(false);
  },
);

test("untrusted certificates are reported as unsent requests, including writes", async () => {
  const f = await setup();
  const untrusted = (async () => {
    throw new TypeError("fetch failed", {
      cause: Object.assign(new Error("self-signed certificate"), {
        code: "DEPTH_ZERO_SELF_SIGNED_CERT",
      }),
    });
  }) as typeof fetch;
  const fresh = new ConfluenceConnections(
    join(f.root, "untrusted.json"),
    f.encryption,
    untrusted,
  );
  await expect(fresh.test(f.input)).rejects.toThrow(/证书验证失败，请求未发送/);
  const service = new ConfluenceService(f.sites, f.artifacts, untrusted);
  const write = service.tools("session1", () => "run-cert")[1];
  const result = await write.execute(
    "tool1",
    { request: { operation: "add_comment", page: "1", content: "hi" } },
    new AbortController().signal,
    undefined,
    {} as never,
  );
  expect(JSON.parse((result.content[0] as { text: string }).text).status).toBe(
    "certificate",
  );
  expect(f.fixture.state.commentCount).toBe(0);
  expect(certificateFailure(new TypeError("fetch failed"))).toBe(false);
  expect(
    certificateFailure({ cause: { cause: { code: "CERT_HAS_EXPIRED" } } }),
  ).toBe(true);
});
