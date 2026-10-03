import { afterEach, expect, test, vi } from "vitest";
import {
  observeToolWait,
  trackToolTask,
  waitForTool,
} from "../src/main/tool-wait";
import { ToolQueue } from "../src/main/tool-queue";
import { requestGate } from "../src/main/connectors/request-gate";
import { FileScheduler } from "../src/main/tools";
import { SerialQueue } from "../src/main/storage";

afterEach(() => vi.useRealTimers());
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("the fifth request waits, reports only after one second, then resumes in FIFO order", async () => {
  vi.useFakeTimers();
  const releases = Array.from({ length: 6 }, () => deferred<Response>());
  const started: number[] = [];
  const gate = requestGate(
    "Confluence",
    "https://fixture.test",
    "fixture",
    vi.fn(),
  );
  const states = Array.from({ length: 6 }, () => vi.fn());
  const calls = states.map((publish, i) =>
    observeToolWait(
      () =>
        gate.fetch(
          new AbortController().signal,
          false,
          () => new Error("limited"),
          () => {
            started.push(i);
            return releases[i].promise;
          },
        ),
      publish,
    ),
  );
  await vi.advanceTimersByTimeAsync(999);
  expect(started).toEqual([0, 1, 2, 3]);
  expect(states[4]).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(states[4]).toHaveBeenLastCalledWith("queue");
  expect(states[5]).toHaveBeenLastCalledWith("queue");
  releases[1].resolve(new Response());
  await vi.advanceTimersByTimeAsync(0);
  expect(started).toEqual([0, 1, 2, 3, 4]);
  expect(states[4]).toHaveBeenLastCalledWith(undefined);
  releases[0].resolve(new Response());
  await vi.advanceTimersByTimeAsync(0);
  expect(started).toEqual([0, 1, 2, 3, 4, 5]);
  releases.forEach((release) => release.resolve(new Response()));
  await Promise.all(calls);
  expect(states[0]).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test("short waits never flash and canceled queued work is never dispatched", async () => {
  vi.useFakeTimers();
  const queue = new ToolQueue(1);
  const hold = deferred();
  const first = queue.run(new AbortController().signal, () => hold.promise);
  const controller = new AbortController();
  const publish = vi.fn();
  const execute = vi.fn(async () => {});
  const waiting = observeToolWait(
    () => queue.run(controller.signal, execute),
    publish,
    controller.signal,
  );
  const rejected = expect(waiting).rejects.toThrow("cancelled");
  await vi.advanceTimersByTimeAsync(500);
  controller.abort(new Error("cancelled"));
  await rejected;
  hold.resolve();
  await first;
  await vi.advanceTimersByTimeAsync(2000);
  expect(publish).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test("visible waiting clears on cancellation without affecting another invocation", async () => {
  vi.useFakeTimers();
  const queue = new ToolQueue(1);
  const hold = deferred();
  const firstState = vi.fn();
  const first = observeToolWait(
    () => queue.run(new AbortController().signal, () => hold.promise),
    firstState,
  );
  const controller = new AbortController();
  const publish = vi.fn();
  const second = observeToolWait(
    () => queue.run(controller.signal, async () => {}),
    publish,
    controller.signal,
  );
  const rejected = expect(second).rejects.toThrow("cancelled");
  await vi.advanceTimersByTimeAsync(1100);
  expect(publish).toHaveBeenLastCalledWith("queue");
  controller.abort(new Error("cancelled"));
  await rejected;
  expect(publish).toHaveBeenLastCalledWith(undefined);
  expect(firstState).not.toHaveBeenCalled();
  hold.resolve();
  await first;
  expect(vi.getTimerCount()).toBe(0);
});

test("nested waiting does not hide a running sibling; all-waiting aggregates once", async () => {
  vi.useFakeTimers();
  const active = deferred();
  const queued = deferred();
  const publish = vi.fn();
  const call = observeToolWait(
    () =>
      Promise.all([
        trackToolTask(() => active.promise),
        trackToolTask(() => waitForTool("queue", () => queued.promise)),
      ]),
    publish,
  );
  await vi.advanceTimersByTimeAsync(2000);
  expect(publish).not.toHaveBeenCalled();
  active.resolve();
  await vi.advanceTimersByTimeAsync(1000);
  expect(publish).toHaveBeenCalledExactlyOnceWith("queue");
  queued.resolve();
  await call;
  expect(publish).toHaveBeenLastCalledWith(undefined);
});

test.each(["retry", "remote", "interval"] as const)(
  "%s waits are explicit and cannot leak into later calls",
  async (reason) => {
    vi.useFakeTimers();
    const hold = deferred();
    const publish = vi.fn();
    const call = observeToolWait(
      () => waitForTool(reason, () => hold.promise),
      publish,
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(publish).toHaveBeenLastCalledWith(reason);
    hold.resolve();
    await call;
    publish.mockClear();
    await observeToolWait(async () => 42, publish);
    await vi.advanceTimersByTimeAsync(2000);
    expect(publish).not.toHaveBeenCalled();
  },
);

test("file and keyed operation queues share the resource waiting state", async () => {
  vi.useFakeTimers();
  const file = new FileScheduler();
  const serial = new SerialQueue();
  for (const run of [
    (fn: () => Promise<void>) =>
      file.run("/private/tmp/worklens-wait-fixture", undefined, () => {}, fn),
    (fn: () => Promise<void>) => serial.run("fixture", fn),
  ]) {
    const hold = deferred();
    const entered = deferred();
    const first = run(() => {
      entered.resolve();
      return hold.promise;
    });
    await entered.promise;
    const publish = vi.fn();
    const second = observeToolWait(() => run(async () => {}), publish);
    // FileScheduler resolves filesystem identity asynchronously before queuing.
    await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0));
    await vi.advanceTimersByTimeAsync(1000);
    expect(publish).toHaveBeenLastCalledWith("resource");
    hold.resolve();
    await Promise.all([first, second]);
    expect(publish).toHaveBeenLastCalledWith(undefined);
  }
});
