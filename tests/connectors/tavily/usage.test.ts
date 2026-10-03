import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { accountUsage } from "../../../src/main/connectors/tavily/usage";
import { TavilyConnections } from "../../../src/main/connectors/tavily/connection";
import { connectorSchemas } from "../../../src/main/connectors/ipc";
import { encryption } from "../github/setup";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const response = (overrides = {}) => ({
  key: { usage: 1, limit: 5 },
  account: {
    current_plan: "Free",
    plan_usage: 56,
    plan_limit: 1000,
    paygo_usage: 0,
    paygo_limit: 0,
    ...overrides,
  },
});

test("account quota does not use the key cap and paid plans do not invent pay-as-you-go", () => {
  expect(accountUsage(response())).toEqual({
    plan: "Free",
    included: { used: 56, limit: 1000 },
  });
  expect(
    accountUsage(response({ current_plan: "Project", paygo_limit: 100 })),
  ).toEqual({
    plan: "Project",
    included: { used: 56, limit: 1000 },
    paygo: { used: 0, limit: 100 },
  });
  expect(
    accountUsage(response({ paygo_usage: 20, paygo_limit: null })).paygo,
  ).toEqual({ used: 20, limit: null });
});

test.each([undefined, null, -1, NaN, Infinity, "1000"])(
  "missing or invalid limits remain unknown: %s",
  (limit) => {
    expect(accountUsage(response({ plan_limit: limit })).included).toEqual({
      used: 56,
      limit: null,
    });
  },
);

test("zero usage and zero limits are preserved, and invalid account objects fail", () => {
  expect(
    accountUsage(response({ plan_usage: 0, plan_limit: 0 })).included,
  ).toEqual({ used: 0, limit: 0 });
  expect(accountUsage(response({ plan_usage: -1 })).included.used).toBeNull();
  for (const value of [null, {}, { account: [] }, { account: "bad" }])
    expect(() => accountUsage(value)).toThrow("TAVILY_USAGE_UNAVAILABLE");
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "worklens-tavily-usage-"));
  roots.push(root);
  const path = join(root, "tavily.json");
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(response()));
  const connections = new TavilyConnections(path, encryption(), fetcher);
  await connections.save({
    url: "https://api.tavily.test",
    token: "synthetic-usage-key",
  });
  return { path, connections, fetcher };
}

test("usage reads are bounded, credential-free over IPC, and do not change saved configuration", async () => {
  const { path, connections, fetcher } = await setup();
  const saved = await readFile(path, "utf8");
  const configuration = connections.configurationKey();
  const value = await connections.usage();
  expect(value.included.used).toBe(56);
  expect(JSON.stringify(value)).not.toContain("synthetic-usage-key");
  const [url, init] = fetcher.mock.calls.at(-1)!;
  expect(url).toBe("https://api.tavily.test/usage");
  expect(init).toMatchObject({
    method: "GET",
    redirect: "manual",
    headers: { authorization: "Bearer synthetic-usage-key" },
  });
  expect(init?.signal).toBeInstanceOf(AbortSignal);
  expect(connections.configurationKey()).toBe(configuration);
  expect(await readFile(path, "utf8")).toBe(saved);
  expect(saved).not.toContain("synthetic-usage-key");
  expect(connectorSchemas.tavilyUsage.safeParse(undefined).success).toBe(true);
  expect(
    connectorSchemas.tavilyUsage.safeParse({ token: "other" }).success,
  ).toBe(false);
});

test("usage errors redact the key without disconnecting a saved connection", async () => {
  const { connections, fetcher } = await setup();
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 300_001);
  fetcher.mockResolvedValueOnce(
    Response.json({ detail: "synthetic-usage-key" }, { status: 401 }),
  );
  await expect(connections.usage()).rejects.toThrow("[redacted]");
  expect(connections.info().configured).toBe(true);
  expect(connections.info().error).toBeUndefined();
});

test("a usage reply cannot survive disconnecting its credentials", async () => {
  const { connections, fetcher } = await setup();
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 300_001);
  let release!: (response: Response) => void;
  fetcher.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = connections.usage().catch(() => "aborted");
  await connections.remove();
  release(Response.json(response()));
  expect(await pending).toBe("aborted");
  await expect(connections.usage()).rejects.toThrow("Tavily");
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test("reopening usage reuses validation for five minutes and coalesces expired reads", async () => {
  const { connections, fetcher } = await setup();
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
  for (let i = 0; i < 20; i++)
    expect((await connections.usage()).included.used).toBe(56);
  expect(fetcher).toHaveBeenCalledOnce();
  clock.mockReturnValue(Date.now() + 300_001);
  fetcher.mockResolvedValueOnce(Response.json(response({ plan_usage: 80 })));
  const results = await Promise.all(
    Array.from({ length: 20 }, () => connections.usage()),
  );
  expect(results.every((result) => result.included.used === 80)).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test("explicit connection tests remain live and update the displayed usage cache", async () => {
  const { connections, fetcher } = await setup();
  fetcher.mockResolvedValueOnce(Response.json(response({ plan_usage: 90 })));
  await connections.test({ url: "https://api.tavily.test" });
  expect((await connections.usage()).included.used).toBe(90);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test.each(["120", null])(
  "rate limit cooldown is shared by usage and connection tests: %s",
  async (retryAfter) => {
    const { connections, fetcher } = await setup();
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 300_001);
    fetcher.mockResolvedValueOnce(
      new Response(null, {
        status: 429,
        headers: retryAfter ? { "retry-after": retryAfter } : {},
      }),
    );
    await expect(connections.usage()).rejects.toThrow("Tavily 要求稍后重试");
    for (let i = 0; i < 10; i++) {
      await expect(connections.usage()).rejects.toThrow("Tavily 要求稍后重试");
      await expect(
        connections.test({ url: "https://api.tavily.test" }),
      ).rejects.toThrow("Tavily 要求稍后重试");
    }
    const cooldown = retryAfter ? 120_000 : 600_000;
    clock.mockReturnValue(Date.now() + cooldown - 1);
    await expect(connections.usage()).rejects.toThrow("Tavily 要求稍后重试");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(connections.info().configured).toBe(true);
    clock.mockReturnValue(Date.now() + 1);
    await expect(connections.usage()).resolves.toMatchObject({
      included: { used: 56 },
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  },
);

test("other usage failures also prevent immediate retry storms", async () => {
  const { connections, fetcher } = await setup();
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 300_001);
  fetcher.mockRejectedValueOnce(new Error("offline"));
  for (let i = 0; i < 10; i++)
    await expect(connections.usage()).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(2);
  clock.mockReturnValue(Date.now() + 60_000);
  await expect(connections.usage()).resolves.toMatchObject({
    included: { used: 56 },
  });
  expect(fetcher).toHaveBeenCalledTimes(3);
});

test("cached usage and cooldowns are scoped to the URL and key", async () => {
  const { connections, fetcher } = await setup();
  fetcher.mockResolvedValueOnce(Response.json(response({ plan_usage: 100 })));
  await connections.save({
    url: "https://api.tavily.test",
    token: "synthetic-new-key",
  });
  expect((await connections.usage()).included.used).toBe(100);
  fetcher.mockResolvedValueOnce(Response.json(response({ plan_usage: 200 })));
  await connections.save({
    url: "https://other.tavily.test",
    token: "synthetic-new-key",
  });
  expect((await connections.usage()).included.used).toBe(200);
  expect(fetcher).toHaveBeenCalledTimes(3);
});

test("disconnecting and reconnecting the same key cannot bypass a rate limit", async () => {
  const { connections, fetcher } = await setup();
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 300_001);
  fetcher.mockResolvedValueOnce(
    new Response(null, {
      status: 429,
      headers: { "retry-after": "120" },
    }),
  );
  await expect(connections.usage()).rejects.toThrow("Tavily 要求稍后重试");
  await connections.remove();
  const input = {
    url: "https://api.tavily.test",
    token: "synthetic-usage-key",
  };
  await expect(connections.save(input)).rejects.toThrow("Tavily 要求稍后重试");
  expect(fetcher).toHaveBeenCalledTimes(2);
  clock.mockReturnValue(Date.now() + 120_000);
  await connections.save(input);
  expect((await connections.usage()).included.used).toBe(56);
  expect(fetcher).toHaveBeenCalledTimes(3);
});

test("manual refresh updates the snapshot after one minute and cannot be spammed", async () => {
  const { connections, fetcher } = await setup();
  const first = await connections.usageState();
  const now = vi.spyOn(Date, "now").mockReturnValue(first.usage!.fetchedAt);
  expect(first.usage!.expiresAt - first.usage!.fetchedAt).toBe(300_000);
  for (let i = 0; i < 12; i++)
    expect(await connections.usageState(true)).toEqual(first);
  expect(fetcher).toHaveBeenCalledOnce();
  now.mockReturnValue(first.refreshAfter);
  fetcher.mockResolvedValueOnce(Response.json(response({ plan_usage: 62 })));
  const refreshed = await connections.usageState(true);
  expect(refreshed.usage!.included.used).toBe(62);
  expect(refreshed.usage!.fetchedAt).toBe(first.refreshAfter);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test("failed refresh retains the old value and timestamp, with the real server cooldown", async () => {
  const { connections, fetcher } = await setup();
  const first = await connections.usageState();
  const now = vi.spyOn(Date, "now").mockReturnValue(first.usage!.expiresAt);
  fetcher.mockResolvedValueOnce(
    new Response(null, { status: 429, headers: { "retry-after": "600" } }),
  );
  const failed = await connections.usageState(true);
  expect(failed).toEqual({
    usage: first.usage,
    error: "rate_limit",
    refreshAfter: Date.now() + 600_000,
  });
  for (let i = 0; i < 12; i++)
    expect(await connections.usageState(true)).toEqual(failed);
  expect(fetcher).toHaveBeenCalledTimes(2);
  now.mockReturnValue(failed.refreshAfter);
  fetcher.mockResolvedValueOnce(Response.json(response({ plan_usage: 62 })));
  expect((await connections.usageState(true)).usage!.included.used).toBe(62);
  expect(fetcher).toHaveBeenCalledTimes(3);
});

test("disconnect and reconnect immediately replaces the previous account snapshot", async () => {
  const { connections, fetcher } = await setup();
  expect((await connections.usage()).included.used).toBe(56);
  await connections.remove();
  fetcher.mockResolvedValueOnce(Response.json(response({ plan_usage: 62 })));
  await connections.save({
    url: "https://api.tavily.test",
    token: "synthetic-usage-key",
  });
  expect((await connections.usage()).included.used).toBe(62);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
