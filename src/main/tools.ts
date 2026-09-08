import { realpath } from "node:fs/promises";
import { resolve, dirname, basename, join } from "node:path";
import { homedir } from "node:os";
import {
  createWriteTool,
  createEditTool,
  createBashTool,
  createPowerShellTool,
  createLocalBashOperations,
  createLocalPowerShellOperations,
} from "@earendil-works/pi-coding-agent";

interface Waiter {
  enter: () => void;
  signal?: AbortSignal;
  abort: () => void;
}
/** Scheduling only; parameters, filesystem operations and results remain Pi-owned. */
export class FileScheduler {
  private locks = new Map<string, Waiter[]>();
  private async key(path: string): Promise<string> {
    let cursor = resolve(path);
    const missing: string[] = [];
    for (;;) {
      try {
        cursor = join(await realpath(cursor), ...missing.reverse());
        break;
      } catch (error) {
        if (
          !["ENOENT", "ENOTDIR"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          throw error;
        const parent = dirname(cursor);
        if (parent === cursor) break;
        missing.push(basename(cursor));
        cursor = parent;
      }
    }
    return process.platform === "win32" ? cursor.toLowerCase() : cursor;
  }
  async run<T>(
    path: string,
    signal: AbortSignal | undefined,
    waiting: () => void,
    execute: () => Promise<T>,
  ): Promise<T> {
    const key = await this.key(path);
    signal?.throwIfAborted();
    await new Promise<void>((resolveWait, reject) => {
      const queue = this.locks.get(key);
      if (!queue) {
        this.locks.set(key, []);
        resolveWait();
        return;
      }
      const waiter: Waiter = {
        signal,
        enter: () => {
          signal?.removeEventListener("abort", waiter.abort);
          resolveWait();
        },
        abort: () => {
          const current = this.locks.get(key);
          const index = current?.indexOf(waiter) ?? -1;
          if (index >= 0) current!.splice(index, 1);
          reject(new Error("等待文件资源时已取消"));
        },
      };
      queue.push(waiter);
      signal?.addEventListener("abort", waiter.abort, { once: true });
      waiting();
    });
    try {
      signal?.throwIfAborted();
      return await execute();
    } finally {
      const queue = this.locks.get(key);
      const next = queue?.shift();
      if (next) next.enter();
      else this.locks.delete(key);
    }
  }
}
const scheduler = new FileScheduler();
export function worklensTools(
  cwd: string,
  state: (id: string, status: "waiting" | "running") => void,
) {
  const mutations = [createWriteTool(cwd), createEditTool(cwd)].map((tool) => ({
    ...tool,
    label: tool.name,
    executionMode: "sequential" as const,
    description:
      tool.description + " 如果修改比较重要的内容，应先通过对话征求用户确认。",
    execute: async (
      id: string,
      args: any,
      signal: AbortSignal | undefined,
      onUpdate: any,
    ) => {
      const path =
        args.path === "~"
          ? homedir()
          : args.path.startsWith("~/") || args.path.startsWith("~\\")
            ? join(homedir(), args.path.slice(2))
            : resolve(cwd, args.path);
      return scheduler.run(
        path,
        signal,
        () => state(id, "waiting"),
        () => {
          state(id, "running");
          return tool.execute(id, args, signal, onUpdate);
        },
      );
    },
  }));
  const shell =
    process.platform === "win32"
      ? createPowerShellTool(cwd)
      : createBashTool(cwd);
  return [
    ...mutations,
    {
      ...shell,
      label: shell.name,
      executionMode: "sequential" as const,
      async execute(...args: Parameters<typeof shell.execute>) {
        const native =
          process.platform === "win32"
            ? createLocalPowerShellOperations()
            : createLocalBashOperations();
        let exitCode: number | null | undefined;
        const operations = {
          exec: async (...input: Parameters<typeof native.exec>) => {
            const result = await native.exec(...input);
            exitCode = result.exitCode;
            return result;
          },
        };
        const invocation =
          process.platform === "win32"
            ? createPowerShellTool(cwd, { operations })
            : createBashTool(cwd, { operations });
        const result = await invocation.execute(...args);
        return {
          ...result,
          details: { ...result.details, worklensShell: { exitCode } },
        };
      },
    },
  ];
}
