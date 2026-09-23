import { lstat, opendir, realpath } from "node:fs/promises";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

// Bound metadata work for large workspaces. Incomplete baselines must never
// turn an unvisited, pre-existing file into evidence of new output.
type Snapshot = { files: Map<string, string>; complete: boolean };
const MAX_ENTRIES = 25000;
const MAX_MS = 1500;

function absolute(cwd: string, path: string) {
  return /^~[\\/]/.test(path)
    ? resolve(homedir(), path.slice(2))
    : resolve(cwd, path);
}
async function fingerprint(path: string) {
  try {
    const info = await lstat(path, { bigint: true });
    return info.isFile()
      ? `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
      : undefined;
  } catch {
    return undefined;
  }
}
async function snapshot(cwd: string): Promise<Snapshot> {
  const files = new Map<string, string>();
  const pending = [cwd];
  const deadline = Date.now() + MAX_MS;
  let entries = 0;
  let complete = true;
  while (pending.length) {
    if (entries >= MAX_ENTRIES || Date.now() > deadline) {
      complete = false;
      break;
    }
    const directory = pending.pop()!;
    try {
      const handle = await opendir(directory);
      for await (const entry of handle) {
        if (++entries > MAX_ENTRIES || Date.now() > deadline) {
          complete = false;
          break;
        }
        const path = join(directory, entry.name);
        // Do not follow links out of the invocation workspace.
        if (entry.isDirectory()) pending.push(path);
        else if (entry.isFile()) {
          const value = await fingerprint(path);
          if (value) files.set(path, value);
        }
      }
    } catch {
      complete = false;
    }
  }
  return { files, complete };
}

/** Capture metadata, not content; preserve exact paths across tool persistence. */
export async function observeFileOutputs(
  cwd: string,
  declared: readonly string[] = [],
) {
  const root = await realpath(cwd).catch(() => cwd);
  const explicit = [
    ...new Set(
      declared
        .slice(0, 256)
        .filter(
          (path) =>
            typeof path === "string" &&
            path.length > 0 &&
            path.length <= 4096 &&
            !/[\0\r\n]/.test(path),
        )
        .map((path) => absolute(root, path)),
    ),
  ];
  const before = await snapshot(root);
  const explicitBefore = new Map(
    await Promise.all(
      explicit.map(async (path) => [path, await fingerprint(path)] as const),
    ),
  );
  return async () => {
    const after = await snapshot(root);
    const outputs = new Set<string>();
    for (const [path, value] of after.files) {
      if (
        (before.complete || before.files.has(path)) &&
        before.files.get(path) !== value
      )
        outputs.add(path);
    }
    for (const path of explicit) {
      const value = await fingerprint(path);
      if (value && value !== explicitBefore.get(path))
        outputs.add(await realpath(path).catch(() => path));
    }
    return [...outputs];
  };
}
