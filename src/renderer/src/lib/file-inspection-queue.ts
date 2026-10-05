import type { ConversationFile } from "../../../shared/contracts";

/** Bound render-time IPC work across threads; abandoned queued work never runs. */
export function createFileInspectionQueue(
  inspect: (id: string, path: string) => Promise<ConversationFile>,
) {
  type Subscriber = {
    resolve: (file: ConversationFile) => void;
    reject: (error: unknown) => void;
    detach: () => void;
  };
  type Job = {
    key: string;
    id: string;
    path: string;
    subscribers: Set<Subscriber>;
  };
  const jobs = new Map<string, Job>();
  const pending: Job[] = [];
  let running = 0;
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    // Yield between IPC completions so navigation can cancel the next batch.
    setTimeout(() => {
      scheduled = false;
      while (running < 2 && pending.length) {
        const job = pending.shift()!;
        if (!job.subscribers.size) continue;
        running++;
        const finish = (file?: ConversationFile, error?: unknown) => {
          if (jobs.get(job.key) === job) jobs.delete(job.key);
          for (const subscriber of job.subscribers) {
            subscriber.detach();
            if (file) subscriber.resolve(file);
            else subscriber.reject(error);
          }
          job.subscribers.clear();
          running--;
          if (pending.length) schedule();
        };
        void Promise.resolve()
          .then(() => inspect(job.id, job.path))
          .then(
            (file) => finish(file),
            (error) => finish(undefined, error),
          );
      }
    }, 0);
  };
  return (id: string, path: string, signal: AbortSignal) => {
    if (signal.aborted) return Promise.reject<ConversationFile>(signal.reason);
    const key = JSON.stringify([id, path]);
    let job = jobs.get(key);
    if (!job) {
      job = { key, id, path, subscribers: new Set() };
      jobs.set(key, job);
      pending.push(job);
    }
    const target = job;
    const result = new Promise<ConversationFile>((resolve, reject) => {
      const abort = () => {
        target.subscribers.delete(subscriber);
        subscriber.detach();
        reject(signal.reason);
        if (!target.subscribers.size && jobs.get(key) === target)
          jobs.delete(key);
      };
      const subscriber: Subscriber = {
        resolve,
        reject,
        detach: () => signal.removeEventListener("abort", abort),
      };
      target.subscribers.add(subscriber);
      signal.addEventListener("abort", abort, { once: true });
    });
    schedule();
    return result;
  };
}

// No result cache: later checks and explicit file actions still see disk changes.
export const inspectConversationFile = createFileInspectionQueue((id, path) =>
  window.worklens.invoke("conversationFile", { id, path, action: "inspect" }),
);
