import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  requestGate,
  retryAfterMs,
  retryBackoff,
} from "../../src/main/connectors/request-gate";
import { GitHubHttp } from "../../src/main/connectors/github/http";
import { JiraHttp } from "../../src/main/connectors/jira/http";
import { ConfluenceHttp } from "../../src/main/connectors/confluence/http";
import { JevHttp } from "../../src/main/connectors/jev/http";

const clock = vi.hoisted(() => ({
  now: 1_800_000_000_000,
  waits: [] as number[],
}));
vi.mock("node:timers/promises", () => ({
  setTimeout: async (
    ms: number,
    _value: unknown,
    options?: { signal?: AbortSignal },
  ) => {
    options?.signal?.throwIfAborted();
    clock.waits.push(ms);
    clock.now += ms;
  },
}));
beforeEach(() => {
  clock.now = 1_800_000_000_000;
  clock.waits = [];
  vi.spyOn(Date, "now").mockImplementation(() => clock.now);
  vi.spyOn(Math, "random").mockReturnValue(0);
});
afterEach(() => vi.restoreAllMocks());
const services = ["GitHub", "Jira", "Confluence", "Jev"] as const;
type Service = (typeof services)[number];
const snapshot = (token = "synthetic-key", url = "https://connector.test") => ({
  settings: {
    url,
    configured: true,
    deployment: "cloud" as const,
    tokenType: "classic" as const,
    email: "test@example.test",
  },
  token,
  revision: "test",
  signal: new AbortController().signal,
});
function call(
  service: Service,
  fetcher: typeof fetch,
  write = false,
  token?: string,
  url?: string,
) {
  const connection = snapshot(token, url);
  if (service === "GitHub")
    return new GitHubHttp(connection, fetcher).rest(
      write ? "POST /items" : "GET /user",
    );
  if (service === "Jira")
    return new JiraHttp(connection, undefined, fetcher).json(
      "/rest/api/2/myself",
      write ? "POST" : "GET",
      write ? {} : undefined,
    );
  if (service === "Confluence")
    return new ConfluenceHttp(connection, undefined, fetcher).json(
      "/rest/api/user",
      write ? "POST" : "GET",
      write ? {} : undefined,
    );
  return new JevHttp(connection, fetcher).request(
    write ? "/v1/systemone" : "/v1/models",
    write ? "{}" : undefined,
  );
}
const ok = () => Response.json({ ok: true });

test.each(services)(
  "%s shares cooldown across clients, retains it until expiry, and isolates credentials/sites",
  async (service) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 429,
          headers: { "retry-after": "120" },
        }),
      )
      .mockImplementation(async () => ok());
    await expect(call(service, fetcher)).rejects.toThrow();
    for (let i = 0; i < 5; i++)
      await expect(call(service, fetcher)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
    clock.now += 119_999;
    await expect(call(service, fetcher)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
    await call(service, fetcher, false, "different-key");
    await call(service, fetcher, false, undefined, "https://another.test");
    expect(fetcher).toHaveBeenCalledTimes(3);
    clock.now++;
    await call(service, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(4);
  },
);

test.each(services)(
  "%s stops queued requests after the first rate limit",
  async (service) => {
    const releases: ((response: Response) => void)[] = [];
    const fetcher = vi.fn<typeof fetch>(
      () =>
        new Promise((resolve) => {
          releases.push(resolve);
        }),
    );
    const pending = Promise.allSettled(
      Array.from({ length: 12 }, () => call(service, fetcher)),
    );
    const maximum = service === "GitHub" ? 1 : 4;
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(maximum));
    for (const release of releases)
      release(
        new Response(null, { status: 429, headers: { "retry-after": "120" } }),
      );
    const results = await pending;
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(maximum);
  },
);

test.each(services)(
  "%s keeps the final retry's cooldown and caps attempts",
  async (service) => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(null, {
          status: 429,
          headers: { "retry-after": "0" },
        }),
    );
    await expect(call(service, fetcher)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(clock.waits).toHaveLength(2);
    expect(clock.waits[1]).toBeGreaterThan(clock.waits[0]);
    await expect(call(service, fetcher)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(3);
  },
);

test.each(["Jira", "Confluence"] as const)(
  "%s does not automatically retry a 429 without Retry-After",
  async (service) => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 429 }),
    );
    await expect(call(service, fetcher)).rejects.toMatchObject({
      code: "rate_limit",
      status: 429,
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(clock.waits).toEqual([]);
  },
);

test.each(["GitHub", "Jira", "Confluence"] as const)(
  "%s never replays writes after rate limits or network failures",
  async (service) => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(null, { status: 429, headers: { "retry-after": "1" } }),
    );
    await expect(call(service, fetcher, true)).rejects.toMatchObject({
      code: "rate_limit",
    });
    expect(fetcher).toHaveBeenCalledOnce();
    const failed = vi.fn<typeof fetch>(async () => {
      throw new Error("connection reset");
    });
    await expect(call(service, failed, true)).rejects.toMatchObject({
      code: "unknown",
    });
    expect(failed).toHaveBeenCalledOnce();
  },
);

test.each(services)(
  "%s does not turn authentication failures into retries or cooldown",
  async (service) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockImplementation(async () => ok());
    await expect(call(service, fetcher)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
    await call(service, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(clock.waits).toEqual([]);
  },
);

test("GitHub honors primary reset after success and secondary limits without headers", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json(
        { ok: true },
        {
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String((clock.now + 120_000) / 1000),
          },
        },
      ),
    )
    .mockImplementation(async () => ok());
  await call("GitHub", fetcher);
  await expect(call("GitHub", fetcher)).rejects.toMatchObject({
    code: "rate_limit",
  });
  expect(fetcher).toHaveBeenCalledOnce();
  clock.now += 120_000;
  await call("GitHub", fetcher);
  const secondary = vi.fn<typeof fetch>(async () =>
    Response.json(
      { message: "You have exceeded a secondary rate limit." },
      { status: 403 },
    ),
  );
  await expect(call("GitHub", secondary)).rejects.toMatchObject({
    code: "rate_limit",
  });
  await expect(call("GitHub", secondary)).rejects.toMatchObject({
    code: "rate_limit",
  });
  expect(secondary).toHaveBeenCalledOnce();
  clock.now += 60_000;
  await expect(call("GitHub", secondary)).rejects.toMatchObject({
    code: "rate_limit",
    data: { retryAfterMs: 120_000 },
  });
  expect(secondary).toHaveBeenCalledTimes(2);
});

test("GitHub GraphQL limits also stop later REST requests", async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({ errors: [{ type: "RATE_LIMITED", message: "limited" }] }),
  );
  await expect(
    new GitHubHttp(snapshot(), fetcher).graphql(
      "query { viewer { login } }",
      {},
    ),
  ).rejects.toMatchObject({ code: "rate_limit" });
  await expect(call("GitHub", fetcher)).rejects.toMatchObject({
    code: "rate_limit",
  });
  expect(fetcher).toHaveBeenCalledOnce();
});

test("GitHub serializes writes and spaces them by at least one second", async () => {
  const times: number[] = [];
  const fetcher = vi.fn<typeof fetch>(async () => {
    times.push(clock.now);
    return ok();
  });
  await Promise.all(
    Array.from({ length: 3 }, () => call("GitHub", fetcher, true)),
  );
  expect(times).toEqual([
    1_800_000_000_000, 1_800_000_001_000, 1_800_000_002_000,
  ]);
});

test("cancelling a queued operation never sends it or blocks the next caller", async () => {
  const fetcher = vi.fn<typeof fetch>();
  const gate = requestGate("GitHub", "https://test", "synthetic", fetcher);
  let release!: (response: Response) => void;
  const active = gate.fetch(
    new AbortController().signal,
    false,
    () => new Error("limited"),
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const controller = new AbortController();
  const cancelled = gate
    .fetch(
      controller.signal,
      true,
      () => new Error("limited"),
      () => fetcher("https://test"),
    )
    .catch((error) => error);
  controller.abort();
  expect(await cancelled).toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  release(ok());
  await active;
  expect(fetcher).not.toHaveBeenCalled();
  await gate.fetch(
    new AbortController().signal,
    false,
    () => new Error("limited"),
    async () => ok(),
  );
});

test("Retry-After accepts dates, seconds and fractions; invalid values use backoff", () => {
  expect(retryAfterMs("120")).toBe(120_000);
  expect(retryAfterMs("1.5")).toBe(1500);
  expect(retryAfterMs(new Date(clock.now + 90_000).toUTCString())).toBe(90_000);
  expect(retryAfterMs("invalid")).toBeUndefined();
  expect(retryAfterMs(null)).toBeUndefined();
  expect(retryAfterMs("0")).toBe(0);
  expect(retryBackoff(0, 2000)).toBe(2000);
  vi.mocked(Math.random).mockReturnValue(1);
  expect(retryBackoff(0, 2000)).toBe(2600);
});

test("Jev retries explicit overload rejections but never repeats a lost evaluation", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(null, { status: 529, headers: { "retry-after": "1" } }),
    )
    .mockImplementation(async () => ok());
  await call("Jev", fetcher, true);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(clock.waits).toEqual([1000]);
  const failed = vi.fn<typeof fetch>(async () => {
    throw new Error("lost response");
  });
  await expect(call("Jev", failed, true)).rejects.toThrow("lost response");
  expect(failed).toHaveBeenCalledOnce();
});

test.each([false, true])(
  "GitHub observes body-only limits before dispatching queued clients: GraphQL %s",
  async (graphql) => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      graphql
        ? Response.json({
            errors: [{ type: "RATE_LIMITED", message: "limited" }],
          })
        : Response.json(
            { message: "You have exceeded a secondary rate limit." },
            { status: 403 },
          ),
    );
    const invoke = () =>
      graphql
        ? new GitHubHttp(snapshot(), fetcher).graphql(
            "query { viewer { login } }",
            {},
          )
        : call("GitHub", fetcher);
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, invoke),
    );
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
    clock.now += 60_000;
    await expect(invoke()).rejects.toThrow();
    clock.now += 60_000;
    await expect(invoke()).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  },
);

test.each(services)(
  "%s shares Retry-After on service unavailability without retrying writes",
  async (service) => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(null, { status: 503, headers: { "retry-after": "120" } }),
    );
    await expect(call(service, fetcher, true)).rejects.toThrow();
    await expect(call(service, fetcher)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  },
);
