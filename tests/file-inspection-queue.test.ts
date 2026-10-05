import { afterEach, expect, it, vi } from "vitest";
import { createFileInspectionQueue } from "../src/renderer/src/lib/file-inspection-queue";

afterEach(() => vi.useRealTimers());

it("limits IPC across sessions and drops queued checks when a thread is left", async () => {
  vi.useFakeTimers();
  const complete: (() => void)[] = [];
  const inspect = vi.fn(
    (_id: string, path: string) =>
      new Promise<any>((resolve) => {
        complete.push(() => resolve({ path, kind: "file" }));
      }),
  );
  const queue = createFileInspectionQueue(inspect);
  const old = new AbortController();
  const results = Array.from({ length: 100 }, (_, i) =>
    queue("old", `file-${i}`, old.signal).catch(() => undefined),
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(inspect).toHaveBeenCalledTimes(2);
  old.abort();
  const next = queue("new", "report.md", new AbortController().signal);
  complete.splice(0).forEach((finish) => finish());
  await vi.runAllTimersAsync();
  expect(inspect).toHaveBeenCalledTimes(3);
  expect(inspect).toHaveBeenLastCalledWith("new", "report.md");
  complete[0]();
  await expect(next).resolves.toMatchObject({ path: "report.md" });
  await Promise.all(results);
});

it("shares in-flight checks without sharing across sessions or caching disk results", async () => {
  vi.useFakeTimers();
  const inspect = vi.fn(async (_id: string, path: string) => ({
    path,
    kind: "file" as const,
  }));
  const queue = createFileInspectionQueue(inspect);
  const cancelled = new AbortController();
  const a = queue("a", "report", cancelled.signal).catch(() => undefined);
  const b = queue("a", "report", new AbortController().signal);
  const c = queue("b", "report", new AbortController().signal);
  cancelled.abort();
  await vi.runAllTimersAsync();
  await Promise.all([a, b, c]);
  expect(inspect).toHaveBeenCalledTimes(2);
  const refreshed = queue("a", "report", new AbortController().signal);
  await vi.runAllTimersAsync();
  await refreshed;
  expect(inspect).toHaveBeenCalledTimes(3);
});

it("releases a failed slot and rejects pre-aborted work without sending IPC", async () => {
  vi.useFakeTimers();
  const inspect = vi.fn(async (_id: string, path: string) => {
    if (path === "bad") throw new Error("unavailable");
    return { path, kind: "file" as const };
  });
  const queue = createFileInspectionQueue(inspect);
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(queue("a", "never", cancelled.signal)).rejects.toBeDefined();
  const bad = queue("a", "bad", new AbortController().signal).catch(
    (error) => error.message,
  );
  const good = queue("a", "good", new AbortController().signal);
  await vi.runAllTimersAsync();
  await expect(bad).resolves.toBe("unavailable");
  await expect(good).resolves.toMatchObject({ path: "good" });
  expect(inspect).toHaveBeenCalledTimes(2);
});
