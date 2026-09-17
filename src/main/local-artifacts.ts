import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  open,
  link,
  rename,
  unlink,
  stat,
  lstat,
  readFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  join,
  resolve,
  isAbsolute,
} from "node:path";
import { homedir } from "node:os";
import { Readable } from "node:stream";
import { atomicJson, SerialQueue } from "./storage";
import type { LocalArtifact } from "../shared/contracts";

export const MAX_FILE_BYTES = 100 * 1024 * 1024;
export function safeFilename(name: string) {
  let value = basename(name.replace(/\\/g, "/"))
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, "_")
    .replace(/[. ]+$/, "");
  if (!value || /^\.+$/.test(value)) value = "document";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value))
    value = "_" + value;
  const extension = extname(value).slice(0, 20);
  const stem = value.slice(0, value.length - extname(value).length);
  let bounded = "";
  for (const char of stem) {
    if (Buffer.byteLength(bounded + char + extension, "utf8") > 180) break;
    bounded += char;
  }
  return (bounded || "document") + extension;
}
export interface Destination {
  directory?: string;
  path?: string;
  overwrite?: boolean;
  expectedFile?: string;
}
export function fileIdentity(info: {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}) {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
}
export class LocalArtifacts {
  private queue = new SerialQueue();
  constructor(
    readonly root: string,
    readonly cwd: string,
  ) {}
  resolvePath(path: string) {
    const expanded =
      path === "~"
        ? homedir()
        : /^~[\\/]/.test(path)
          ? join(homedir(), path.slice(2))
          : path;
    return isAbsolute(expanded)
      ? resolve(expanded)
      : resolve(this.cwd, expanded);
  }
  async directory(
    sessionId: string,
    connector: "confluence" | "jira" | "github" | "tavily" = "confluence",
  ) {
    if (!/^[\w-]+$/.test(sessionId)) throw new Error("Invalid session ID");
    const directory = join(
      this.root,
      "files",
      sessionId,
      connector,
      randomUUID(),
    );
    await mkdir(directory, { recursive: true });
    return directory;
  }
  async save(
    sessionId: string,
    name: string,
    source: AsyncIterable<Uint8Array> | string,
    destination: Destination = {},
    signal?: AbortSignal,
    connector: "confluence" | "jira" | "github" | "tavily" = "confluence",
  ): Promise<LocalArtifact> {
    if (destination.path && destination.directory)
      throw new Error("只能指定文件路径或目录其中之一");
    const exact = destination.path
      ? this.resolvePath(destination.path)
      : undefined;
    const directory = exact
      ? dirname(exact)
      : destination.directory
        ? this.resolvePath(destination.directory)
        : await this.directory(sessionId, connector);
    await mkdir(directory, { recursive: true });
    const temp = join(directory, `.worklens-${randomUUID()}.part`);
    const handle = await open(temp, "wx", 0o600);
    let size = 0;
    try {
      const iterable =
        typeof source === "string" ? [Buffer.from(source)] : source;
      for await (const chunk of iterable) {
        signal?.throwIfAborted();
        size += chunk.byteLength;
        if (size > MAX_FILE_BYTES) throw new Error("文件超过 100 MiB 限制");
        let offset = 0;
        while (offset < chunk.byteLength)
          offset += (await handle.write(chunk, offset)).bytesWritten;
      }
      await handle.sync();
      await handle.close();
      signal?.throwIfAborted();
      const initial = exact ?? join(directory, safeFilename(name));
      let target = initial;
      if (exact && destination.overwrite) {
        await this.queue.run(exact, async () => {
          const existing = await lstat(exact).catch((e) => {
            if (e.code !== "ENOENT") throw e;
          });
          if (existing && (!existing.isFile() || existing.isSymbolicLink()))
            throw new Error("覆盖目标必须是普通文件，不能是目录或符号链接");
          if (
            destination.expectedFile &&
            (!existing || fileIdentity(existing) !== destination.expectedFile)
          )
            throw new Error(
              "目标文件在传输期间已变更，未覆盖。请重新读取目标。",
            );
          signal?.throwIfAborted();
          await rename(temp, exact);
        });
      } else {
        for (let suffix = 0; ; suffix++) {
          signal?.throwIfAborted();
          const extension = extname(initial);
          target = suffix
            ? initial.slice(0, initial.length - extension.length) +
              ` (${suffix})` +
              extension
            : initial;
          try {
            await link(temp, target);
            break;
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
            if (exact)
              throw new Error(
                `文件已存在：${exact}。请选择其他路径，或设置 overwrite: true 覆盖。`,
              );
            if (suffix >= 999) throw new Error("同名文件过多");
          }
        }
      }
      const artifact = {
        id: randomUUID(),
        name: basename(target),
        path: target,
        size,
      };
      await atomicJson(
        join(this.root, "index", artifact.id + ".json"),
        artifact,
      );
      return artifact;
    } finally {
      await handle.close().catch(() => {});
      await unlink(temp).catch(() => {});
    }
  }
  async get(id: string): Promise<LocalArtifact> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("无效文件标识");
    const artifact = JSON.parse(
      await readFile(join(this.root, "index", id + ".json"), "utf8"),
    ) as LocalArtifact;
    if (artifact.id !== id || !isAbsolute(artifact.path))
      throw new Error("文件记录无效");
    if (!(await stat(artifact.path)).isFile()) throw new Error("文件已不存在");
    return artifact;
  }
  copy(id: string, destination: string) {
    return this.queue.run("copy:" + destination, async () => {
      const artifact = await this.get(id);
      return this.save(
        "saved",
        artifact.name,
        createReadStream(artifact.path),
        { path: destination, overwrite: true },
      );
    });
  }
  static stream(response: Response) {
    if (!response.body) throw new Error("下载内容为空");
    if (Number(response.headers.get("content-length")) > MAX_FILE_BYTES) {
      void response.body.cancel();
      throw new Error("文件超过 100 MiB 限制");
    }
    return Readable.fromWeb(
      response.body as import("node:stream/web").ReadableStream,
    );
  }
}
