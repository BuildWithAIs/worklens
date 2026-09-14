/** Serial service requests with prompt cancellation while waiting for a slot. */
export class RequestQueue {
  private active = false;
  private waiting: {
    enter: () => void;
    signal: AbortSignal;
    abort: () => void;
  }[] = [];
  async run<T>(signal: AbortSignal, execute: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    if (!this.active) this.active = true;
    else
      await new Promise<void>((resolve, reject) => {
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
      });
    try {
      signal.throwIfAborted();
      return await execute();
    } finally {
      const next = this.waiting.shift();
      if (next) {
        next.signal.removeEventListener("abort", next.abort);
        next.enter();
      } else this.active = false;
    }
  }
}
