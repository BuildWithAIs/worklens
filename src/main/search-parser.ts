import { Worker } from "node:worker_threads";
import type { Checkpoint } from "./conversation-search";

export type SearchTextKind = "markdown" | "text" | "source";
export interface IndexedSearchText {
  text: string;
  folded: string;
}

function defaultWorkerUrl() {
  // Vitest builds the real worker once from source before starting test workers.
  // Desktop builds emit it alongside the main entry, including inside ASAR.
  const testUrl = process.env.VITEST && process.env.WORKLENS_TEST_SEARCH_WORKER;
  return testUrl
    ? new URL(testUrl)
    : new URL("./search-parser-worker.js", import.meta.url);
}

/** One reusable worker; cancelled work is terminated before the queue advances. */
export class SearchParser {
  private worker?: Worker;
  private tail: Promise<unknown> = Promise.resolve();
  private stop?: () => void;

  constructor(private url = defaultWorkerUrl()) {}

  read(
    text: string,
    kind: SearchTextKind,
    checkpoint: Checkpoint,
  ): Promise<IndexedSearchText> {
    const result = this.tail.then(async () => {
      await checkpoint();
      const worker = (this.worker ??= new Worker(this.url));
      // Keep an idle worker's exit/error from leaving a dead cached handle.
      if (!worker.listenerCount("error")) {
        worker.on("error", () => {});
        worker.on("exit", () => {
          if (this.worker === worker) this.worker = undefined;
        });
      }
      worker.ref();
      return new Promise<IndexedSearchText>((resolve, reject) => {
        let checking = false;
        let settled = false;
        const clean = () => {
          settled = true;
          clearInterval(timer);
          worker.off("message", received);
          worker.off("error", fail);
          worker.off("exit", exited);
          this.stop = undefined;
        };
        const fail = (error: Error) => {
          if (settled) return;
          clean();
          if (this.worker === worker) this.worker = undefined;
          void worker.terminate();
          reject(error);
        };
        const received = (value: IndexedSearchText & { error?: string }) => {
          if (settled) return;
          if (value.error) return fail(new Error(value.error));
          clean();
          worker.unref();
          resolve(value);
        };
        const exited = () => fail(new Error("Search parser stopped"));
        // The main process stays free to receive IPC cancellation while parsing.
        const timer = setInterval(async () => {
          if (checking) return;
          checking = true;
          try {
            await checkpoint();
          } catch (error) {
            fail(error as Error);
          } finally {
            checking = false;
          }
        }, 10);
        this.stop = () => fail(new Error("Search parser closed"));
        worker.once("message", received);
        worker.once("error", fail);
        worker.once("exit", exited);
        worker.postMessage({ text, kind });
      });
    });
    this.tail = result.catch(() => {});
    return result;
  }

  close() {
    if (this.stop) this.stop();
    else if (this.worker) void this.worker.terminate();
    this.worker = undefined;
  }
}

export const searchParser = new SearchParser();
