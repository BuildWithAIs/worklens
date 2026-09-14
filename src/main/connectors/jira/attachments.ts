import { open } from "node:fs/promises";
import type { Execution } from "./context";
import { ServiceError } from "./http";
import { MAX_FILE_BYTES } from "../../local-artifacts";

export async function uploadBytes(ctx: Execution, path: string) {
  const handle = await open(ctx.artifacts.resolvePath(path), "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_FILE_BYTES)
      throw new ServiceError("invalid_file", "请选择不超过 100 MiB 的普通文件");
    ctx.signal.throwIfAborted();
    const buffer = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < buffer.length) {
      ctx.signal.throwIfAborted();
      const chunk = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (!chunk.bytesRead) throw new Error("文件在读取时发生变化");
      offset += chunk.bytesRead;
    }
    const after = await handle.stat();
    if (info.size !== after.size || info.mtimeMs !== after.mtimeMs)
      throw new Error("文件在读取时发生变化");
    return buffer;
  } finally {
    await handle.close();
  }
}
