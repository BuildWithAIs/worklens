import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";
import type { ToolWaitReason } from "../shared/contracts";

type Task = { reason?: ToolWaitReason; children: Set<Task> };
type Context = { task: Task; changed: () => void };
const context = new AsyncLocalStorage<Context>();

function waitingReason(task: Task): ToolWaitReason | undefined {
  if (!task.children.size) return task.reason;
  const reasons = [...task.children].map(waitingReason);
  // A parallel sibling that is still working takes precedence over waiting.
  return reasons.every(Boolean) ? reasons[0] : undefined;
}

/** Presentation only. Each invocation (including nested Code Mode tools) owns
 * its state; no queue policy, request data, or tool output crosses this boundary.
 */
export async function observeToolWait<T>(
  execute: () => Promise<T>,
  publish: (reason: ToolWaitReason | undefined) => void,
  signal?: AbortSignal,
): Promise<T> {
  const root: Task = { children: new Set() };
  let closed = false;
  let visible: ToolWaitReason | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const changed = () => {
    if (closed) return;
    const reason = waitingReason(root);
    if (!reason) {
      clear();
      if (visible) {
        visible = undefined;
        publish(undefined);
      }
    } else if (visible) {
      if (visible !== reason) publish((visible = reason));
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = undefined;
        const current = waitingReason(root);
        if (!closed && current) publish((visible = current));
      }, 1000);
      timer.unref();
    }
  };
  const close = () => {
    closed = true;
    clear();
    if (visible) {
      visible = undefined;
      publish(undefined);
    }
  };
  signal?.addEventListener("abort", close, { once: true });
  if (signal?.aborted) close();
  try {
    return await context.run({ task: root, changed }, execute);
  } finally {
    signal?.removeEventListener("abort", close);
    close();
  }
}

/** Track the whole operation so a waiting child does not hide active siblings. */
export function trackToolTask<T>(execute: () => Promise<T>): Promise<T> {
  return taskScope(undefined, execute);
}

export function waitForTool<T>(
  reason: ToolWaitReason,
  execute: () => Promise<T>,
): Promise<T> {
  return taskScope(reason, execute);
}

async function taskScope<T>(
  reason: ToolWaitReason | undefined,
  execute: () => Promise<T>,
): Promise<T> {
  const parent = context.getStore();
  if (!parent) return execute();
  const task: Task = { reason, children: new Set() };
  parent.task.children.add(task);
  parent.changed();
  try {
    return await context.run({ ...parent, task }, execute);
  } finally {
    parent.task.children.delete(task);
    parent.changed();
  }
}

/** Same timer and cancellation behavior as connector retry delays. */
export function toolRetryDelay(
  ms: number,
  value?: undefined,
  options?: { signal?: AbortSignal },
) {
  return waitForTool("retry", () => delay(ms, value, options));
}
