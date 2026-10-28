import { expect, test, vi } from "vitest";
import type { Dispatcher } from "undici";
import {
  FAILURE_TTL_MS,
  markProxyFailure,
  NetworkHealth,
} from "../src/main/network-health";

// Raised while connecting to the proxy, as the proxy agent marks it.
const refused = Object.assign(new Error("synthetic request detail"), {
  code: "ECONNREFUSED",
});
markProxyFailure(refused);
function legacy(
  health: NetworkHealth,
  origin = "https://one.example.test",
  kind: "proxy" | "bypass" = "proxy",
) {
  const handler = {
    onError: vi.fn(),
    onHeaders: vi.fn(() => true),
    onConnect: vi.fn(),
  };
  return { handler, observed: health.observe(origin, kind, handler) };
}
test("failures retain request behavior and publish only aggregate flags", () => {
  const changed = vi.fn();
  const health = new NetworkHealth(changed);
  const { handler, observed } = legacy(health);
  observed.onError!(refused);
  expect(handler.onError).toHaveBeenCalledWith(refused);
  expect(health.snapshot()).toEqual({
    revision: 1,
    proxy: true,
    bypass: false,
  });
  legacy(health).observed.onError!(refused);
  expect(changed).toHaveBeenCalledTimes(1);
});
test("only the failed destination recovers; proxy and bypass warnings are independent", () => {
  const health = new NetworkHealth(vi.fn());
  legacy(health).observed.onError!(refused);
  legacy(health, "https://bypass.example.test", "bypass").observed.onError!(
    refused,
  );
  legacy(health, "https://unrelated.example.test").observed.onHeaders!(
    200,
    [],
    () => {},
    "OK",
  );
  expect(health.snapshot()).toMatchObject({ proxy: true, bypass: true });
  legacy(health).observed.onHeaders!(500, [], () => {}, "Server error");
  expect(health.snapshot()).toMatchObject({ proxy: false, bypass: true });
});
test("older results and callbacks from old settings cannot overwrite current status", () => {
  const health = new NetworkHealth(vi.fn());
  const old = legacy(health);
  legacy(health).observed.onError!(refused);
  old.observed.onHeaders!(200, [], () => {}, "OK");
  expect(health.snapshot().proxy).toBe(true);
  const late = legacy(health);
  legacy(health).observed.onHeaders!(200, [], () => {}, "OK");
  late.observed.onError!(refused);
  expect(health.snapshot().proxy).toBe(false);
  const pending = legacy(health);
  health.reset();
  pending.observed.onError!(refused);
  expect(health.snapshot().proxy).toBe(false);
});
test("program errors, user cancellation and HTTP failures do not create network warnings", () => {
  const health = new NetworkHealth(vi.fn());
  legacy(health).observed.onError!(new Error("synthetic program error"));
  const cancelled = legacy(health);
  const abort = vi.fn();
  cancelled.observed.onConnect!(abort);
  cancelled.handler.onConnect.mock.calls[0][0](refused);
  cancelled.observed.onError!(refused);
  expect(abort).toHaveBeenCalledWith(refused);
  legacy(health).observed.onHeaders!(401, [], () => {}, "Unauthorized");
  expect(health.snapshot()).toMatchObject({ proxy: false, bypass: false });
});
test("current Undici handlers preserve controller calls, private receivers and return values", () => {
  const health = new NetworkHealth(vi.fn());
  const controller: Dispatcher.DispatchController = {
    aborted: false,
    paused: false,
    reason: null,
    abort: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
  };
  class Handler implements Dispatcher.DispatchHandler {
    #error?: Error;
    onRequestStart(value: Dispatcher.DispatchController) {
      value.pause();
    }
    onResponseError(_value: Dispatcher.DispatchController, error: Error) {
      this.#error = error;
    }
    error() {
      return this.#error;
    }
  }
  const handler = new Handler();
  const observed = health.observe(
    "https://current.example.test",
    "bypass",
    handler,
  );
  observed.onRequestStart!(controller, null);
  observed.onResponseError!(controller, refused);
  expect(controller.pause).toHaveBeenCalledTimes(1);
  expect(handler.error()).toBe(refused);
  expect(health.snapshot().bypass).toBe(true);
});
test("a proxy refusing CONNECT is reported while cancellation remains silent", () => {
  const health = new NetworkHealth(vi.fn());
  legacy(health).observed.onError!(
    Object.assign(
      new Error("Proxy response (407) !== 200 when HTTP Tunneling"),
      { code: "UND_ERR_ABORTED" },
    ),
  );
  expect(health.snapshot().proxy).toBe(true);
});

test("a proxy that cannot reach the destination is not reported", () => {
  const health = new NetworkHealth(vi.fn());
  for (const status of [502, 503, 504])
    legacy(health, `https://down-${status}.example.test`).observed.onError!(
      Object.assign(
        new Error(`Proxy response (${status}) !== 200 when HTTP Tunneling`),
        { code: "UND_ERR_ABORTED" },
      ),
    );
  expect(health.snapshot().proxy).toBe(false);
});

test("only failures reaching the route count, not the destination behind it", () => {
  const health = new NetworkHealth(vi.fn());
  const certificate = () =>
    Object.assign(new Error("synthetic certificate"), {
      code: "DEPTH_ZERO_SELF_SIGNED_CERT",
    });
  // Through an open tunnel, the same codes come from the destination.
  legacy(health, "https://tunnel.example.test").observed.onError!(
    Object.assign(new Error("synthetic refusal"), { code: "ECONNREFUSED" }),
  );
  legacy(health, "https://cert.example.test").observed.onError!(certificate());
  // Directly, a reachable host's certificate or reset is its own.
  legacy(health, "https://direct.example.test", "bypass").observed.onError!(
    certificate(),
  );
  legacy(health, "https://reset.example.test", "bypass").observed.onError!(
    Object.assign(new Error("synthetic reset"), { code: "ECONNRESET" }),
  );
  expect(health.snapshot()).toMatchObject({ proxy: false, bypass: false });
  // The proxy's own certificate is checked before any tunnel exists.
  const proxyCertificate = certificate();
  markProxyFailure(proxyCertificate);
  legacy(health, "https://cert.example.test").observed.onError!(
    proxyCertificate,
  );
  legacy(health, "https://direct.example.test", "bypass").observed.onError!(
    Object.assign(new Error("synthetic lookup"), { code: "ENOTFOUND" }),
  );
  expect(health.snapshot()).toMatchObject({ proxy: true, bypass: true });
});

test("failures expire when their destination is never retried", () => {
  vi.useFakeTimers();
  try {
    const changed = vi.fn();
    const health = new NetworkHealth(changed);
    legacy(health).observed.onError!(refused);
    vi.advanceTimersByTime(FAILURE_TTL_MS / 2);
    // A repeated failure renews the warning.
    legacy(health).observed.onError!(refused);
    vi.advanceTimersByTime(FAILURE_TTL_MS - 1);
    expect(health.snapshot().proxy).toBe(true);
    vi.advanceTimersByTime(1);
    expect(health.snapshot().proxy).toBe(false);
    expect(changed).toHaveBeenLastCalledWith(
      expect.objectContaining({ proxy: false }),
    );
  } finally {
    vi.useRealTimers();
  }
});

test("wrapped timeouts are reported but an explicit cancellation with that reason is ignored", () => {
  const health = new NetworkHealth(vi.fn());
  const timeout = Object.assign(new Error("synthetic timeout"), {
    code: "UND_ERR_CONNECT_TIMEOUT",
  });
  markProxyFailure(timeout);
  legacy(health).observed.onError!(
    new Error("fetch failed", { cause: new AggregateError([timeout]) }),
  );
  expect(health.snapshot().proxy).toBe(true);
  health.reset();
  const controller: Dispatcher.DispatchController = {
    aborted: false,
    paused: false,
    reason: null,
    abort: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
  };
  const handler: Dispatcher.DispatchHandler = {
    onRequestStart: (current) => current.abort(timeout),
    onResponseError: vi.fn(),
  };
  const observed = health.observe(
    "https://cancel.example.test",
    "proxy",
    handler,
  );
  observed.onRequestStart!(controller, null);
  observed.onResponseError!(controller, timeout);
  expect(controller.abort).toHaveBeenCalledWith(timeout);
  expect(health.snapshot().proxy).toBe(false);
});

test("the status callback and unexpected error properties cannot interrupt delivery", () => {
  const health = new NetworkHealth(() => {
    throw new Error("synthetic observer failure");
  });
  const request = legacy(health);
  expect(() => request.observed.onError!(refused)).not.toThrow();
  const unexpected = Object.defineProperty(
    new Error("synthetic unusual error"),
    "code",
    {
      get() {
        throw new Error("synthetic getter failure");
      },
    },
  );
  const second = legacy(health);
  second.observed.onError!(unexpected);
  expect(second.handler.onError.mock.calls[0][0] === unexpected).toBe(true);
});

test("many unrelated destinations cannot evict outstanding failures", () => {
  const health = new NetworkHealth(vi.fn());
  legacy(health).observed.onError!(refused);
  for (let i = 0; i < 300; i++) {
    legacy(health, `https://host-${i}.example.test`).observed.onHeaders!(
      200,
      [],
      () => {},
      "OK",
    );
  }
  expect(health.snapshot().proxy).toBe(true);
  legacy(health).observed.onHeaders!(200, [], () => {}, "OK");
  expect(health.snapshot().proxy).toBe(false);
});

test("a newly selected proxy does not inherit the old proxy's failures", () => {
  const health = new NetworkHealth(vi.fn());
  const first = health.observe(
    "https://one.example.test",
    "proxy",
    { onError: vi.fn() },
    "http://first.example.test",
  );
  first.onError!(refused);
  const next = health.observe(
    "https://one.example.test",
    "proxy",
    { onError: vi.fn() },
    "http://second.example.test",
  );
  expect(health.snapshot().proxy).toBe(false);
  first.onError!(refused);
  expect(health.snapshot().proxy).toBe(false);
  next.onError!(refused);
  expect(health.snapshot().proxy).toBe(true);
});
