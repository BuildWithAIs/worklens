import { trackToolTask, waitForTool } from "./tool-wait";

/** Shared FIFO queue. New tool/connector queues also inherit waiting feedback. */
export class ToolQueue {
  private active = 0;
  private waiting: {
    enter: () => void;
    signal: AbortSignal;
    abort: () => void;
  }[] = [];
  constructor(private maximum = 4) {}

  run<T>(signal: AbortSignal, execute: () => Promise<T>): Promise<T> {
    return trackToolTask(async () => {
      signal.throwIfAborted();
      if (this.active < this.maximum) this.active++;
      else
        await waitForTool(
          "queue",
          () =>
            new Promise<void>((resolve, reject) => {
              const waiter = {
                enter: resolve,
                signal,
                abort: () => {
                  const index = this.waiting.indexOf(waiter);
                  if (index >= 0) this.waiting.splice(index, 1);
                  reject(signal.reason);
                },
              };
              this.waiting.push(waiter);
              signal.addEventListener("abort", waiter.abort, { once: true });
            }),
        );
      try {
        signal.throwIfAborted();
        return await execute();
      } finally {
        const waiter = this.waiting.shift();
        if (waiter) {
          waiter.signal.removeEventListener("abort", waiter.abort);
          waiter.enter();
        } else this.active--;
      }
    });
  }
}
