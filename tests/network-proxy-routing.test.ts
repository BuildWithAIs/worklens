import { afterEach, expect, test, vi } from "vitest";
import { Agent } from "undici";
import type { LookupAddress } from "node:dns";
import type { ProxySettings } from "../src/shared/contracts";
import { ProxyRouter, bypassLookup } from "../src/main/network-proxy";

const proxy = "http://127.0.0.1:7890";
const routers: { router: ProxyRouter; direct: Agent }[] = [];

function routing(
  resolve = vi.fn(async (): Promise<LookupAddress[]> => []),
  bypass = "160.0.0.0/8",
) {
  let settings: ProxySettings = { mode: "custom", url: proxy, bypass };
  const direct = new Agent();
  const router = new ProxyRouter(
    direct,
    () => settings,
    async () => proxy,
    resolve,
  );
  routers.push({ router, direct });
  return {
    router,
    resolve,
    apply(next: ProxySettings) {
      settings = next;
      router.reset();
    },
  };
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(
    routers
      .splice(0)
      .flatMap(({ router, direct }) => [router.destroy(), direct.destroy()]),
  );
});

test("literal IPs match CIDRs without DNS; out-of-range addresses use the proxy", async () => {
  const { router, resolve } = routing();
  expect(router.route("https://160.12.34.56")).toBeUndefined();
  expect(router.route("https://161.12.34.56")).toBe(proxy);
  expect(router.route("https://[2001:db8::1]")).toBe(proxy);
  expect(resolve).not.toHaveBeenCalled();
});

test("domains use only matching DNS answers, including IPv6", async () => {
  const resolve = vi.fn(async () => [
    { address: "192.0.2.1", family: 4 },
    { address: "160.12.34.56", family: 4 },
    { address: "2001:db8::1", family: 6 },
  ]);
  const { router } = routing(resolve, "160.0.0.0/8,2001:db8::/32");
  expect(await router.route("https://service.example.test")).toEqual({
    addresses: [
      { address: "160.12.34.56", family: 4 },
      { address: "2001:db8::1", family: 6 },
    ],
  });
});

test("nonmatching, empty, and failed DNS results retain the proxy", async () => {
  const { router, resolve } = routing();
  resolve.mockResolvedValueOnce([{ address: "192.0.2.1", family: 4 }]);
  resolve.mockResolvedValueOnce([]);
  resolve.mockRejectedValueOnce(new Error("Synthetic DNS failure"));
  for (const origin of [
    "https://one.example.test",
    "https://two.example.test",
    "https://three.example.test",
  ])
    expect(await router.route(origin)).toBe(proxy);
});

test("DNS timeouts fall back to the proxy and ignore late results", async () => {
  vi.useFakeTimers();
  let complete!: (addresses: LookupAddress[]) => void;
  const resolve = vi.fn(
    () =>
      new Promise<LookupAddress[]>((done) => {
        complete = done;
      }),
  );
  const { router } = routing(resolve);
  const route = router.route("https://service.example.test");
  await vi.advanceTimersByTimeAsync(2000);
  expect(await route).toBe(proxy);
  complete([{ address: "160.12.34.56", family: 4 }]);
  await Promise.resolve();
  expect(await router.route("https://service.example.test")).toBe(proxy);
});

test("concurrent requests share DNS and refresh after 30 seconds", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(1000);
  const { router, resolve } = routing(
    vi.fn(async () => [{ address: "160.12.34.56", family: 4 }]),
  );
  await Promise.all([
    router.route("https://service.example.test"),
    router.route("https://service.example.test"),
  ]);
  expect(resolve).toHaveBeenCalledTimes(1);
  now.mockReturnValue(31_001);
  resolve.mockResolvedValue([{ address: "192.0.2.1", family: 4 }]);
  expect(await router.route("https://service.example.test")).toBe(proxy);
  expect(resolve).toHaveBeenCalledTimes(2);
});

test("settings changes cannot be overwritten by pending DNS results", async () => {
  let complete!: (addresses: LookupAddress[]) => void;
  const resolve = vi.fn(
    () =>
      new Promise<LookupAddress[]>((done) => {
        complete = done;
      }),
  );
  const { router, apply } = routing(resolve);
  const old = router.route("https://service.example.test");
  await Promise.resolve();
  apply({ mode: "custom", url: proxy });
  complete([{ address: "160.12.34.56", family: 4 }]);
  await old;
  expect(router.route("https://service.example.test")).toBe(proxy);
});

test("host rules and modes without CIDRs never introduce DNS queries", async () => {
  const { router, resolve, apply } = routing(
    undefined,
    "example.test, 160.0.0.0/8",
  );
  expect(router.route("https://api.example.test")).toBeUndefined();
  apply({ mode: "custom", url: proxy, bypass: "invalid.test/8" });
  expect(router.route("https://service.test")).toBe(proxy);
  apply({ mode: "off", bypass: "160.0.0.0/8" });
  expect(router.route("https://service.test")).toBeUndefined();
  apply({ mode: "system", bypass: "160.0.0.0/8" });
  expect(await router.route("https://service.test")).toBe(proxy);
  expect(resolve).not.toHaveBeenCalled();
});

test("cache and outstanding DNS work remain bounded", async () => {
  vi.useFakeTimers();
  const resolve = vi.fn(() => new Promise<LookupAddress[]>(() => {}));
  const { router } = routing(resolve);
  const pending = Array.from({ length: 300 }, (_, i) =>
    router.route(`https://host-${i}.example.test`),
  );
  await vi.advanceTimersByTimeAsync(2000);
  expect((await Promise.all(pending)).every((route) => route === proxy)).toBe(
    true,
  );
  expect(resolve).toHaveBeenCalledTimes(32);
});

test("current Undici handlers can cancel during DNS without a second request start", async () => {
  const { router } = routing();
  const error = new Error("Synthetic cancellation");
  const start = vi.fn((controller) => controller.abort(error));
  const fail = vi.fn();
  router.dispatch(
    { origin: "https://service.example.test", method: "GET", path: "/" },
    {
      onRequestStart: start,
      onResponseError: fail,
    },
  );
  await new Promise((done) => setImmediate(done));
  expect(start).toHaveBeenCalledTimes(1);
  expect(fail).toHaveBeenCalledTimes(1);
  expect(fail).toHaveBeenCalledWith(
    expect.objectContaining({ aborted: true }),
    error,
  );
});

test("closing the router fails pending requests before DNS finishes", async () => {
  let complete!: (addresses: LookupAddress[]) => void;
  const { router } = routing(
    vi.fn(
      () =>
        new Promise<LookupAddress[]>((done) => {
          complete = done;
        }),
    ),
  );
  const fail = vi.fn();
  router.dispatch(
    { origin: "https://service.example.test", method: "GET", path: "/" },
    {
      onConnect: () => {},
      onError: fail,
    },
  );
  await Promise.resolve();
  await router.destroy();
  expect(fail).toHaveBeenCalledTimes(1);
  complete([]);
  await new Promise((done) => setImmediate(done));
  expect(fail).toHaveBeenCalledTimes(1);
});

test("the route cache evicts old origins while retaining recent results", async () => {
  const { router, resolve } = routing();
  for (let i = 0; i <= 256; i++)
    await router.route(`https://host-${i}.example.test`);
  expect(resolve).toHaveBeenCalledTimes(257);
  await router.route("https://host-256.example.test");
  expect(resolve).toHaveBeenCalledTimes(257);
  await router.route("https://host-0.example.test");
  expect(resolve).toHaveBeenCalledTimes(258);
});

test("bypass lookups answer asynchronously, like DNS", async () => {
  // Node connects inside a synchronous lookup answer, so a connect that fails
  // at once (EADDRNOTAVAIL after a network change) would throw before Undici
  // attaches its error handler and crash the main process.
  const lookup = bypassLookup([{ address: "160.12.34.56", family: 4 }]);
  for (const options of [{ all: true }, {}]) {
    const callback = vi.fn();
    lookup("bypass.example.test", options, callback);
    expect(callback).not.toHaveBeenCalled();
    await new Promise((resolve) => setImmediate(resolve));
    expect(callback).toHaveBeenCalledTimes(1);
  }
  const missing = vi.fn();
  bypassLookup([])("bypass.example.test", { family: 4 }, missing);
  expect(missing).not.toHaveBeenCalled();
  await new Promise((resolve) => setImmediate(resolve));
  expect(missing.mock.calls[0][0]).toMatchObject({ code: "ENOTFOUND" });
});
