import { lstat, mkdir, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SessionManager } from "@earendil-works/pi-coding-agent";

export function sessionDirectory(sessions: string, id: string) {
  if (!/^[\w-]+$/.test(id)) throw new Error("Invalid session ID");
  return join(sessions, id);
}

export function sessionWorkspace(sessions: string, id: string) {
  return join(sessionDirectory(sessions, id), "workspace");
}

export function workingDirectory(
  paths: { sessions: string; runtime: string },
  manager: SessionManager,
) {
  const isolated = manager
    .getEntries()
    .some(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === "worklens.workspace" &&
        (entry.data as { version?: number } | undefined)?.version === 1,
    );
  return isolated
    ? sessionWorkspace(paths.sessions, manager.getSessionId())
    : paths.runtime;
}

export function isWithin(root: string, path: string) {
  const part = relative(resolve(root), resolve(path));
  return (
    !!part && part !== ".." && !part.startsWith(".." + sep) && !isAbsolute(part)
  );
}

// Only traverse real directories beneath the application-owned root. In
// particular, a replaced session directory must never redirect writes/cleanup.
export async function ownedDirectory(
  root: string,
  path: string,
  create = false,
) {
  if (!isWithin(root, path)) throw new Error("Invalid managed file directory");
  if (create) await mkdir(root, { recursive: true });
  let current = root;
  for (const part of relative(resolve(root), resolve(path)).split(sep)) {
    current = join(current, part);
    if (create)
      await mkdir(current).catch((error) => {
        if (error.code !== "EEXIST") throw error;
      });
    const info = await lstat(current).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (!info) return false;
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error(
        "Managed file directory must not be a symbolic link or file",
      );
  }
  return true;
}

export async function removeOwnedDirectory(root: string, path: string) {
  if (await ownedDirectory(root, path))
    await rm(path, { recursive: true, force: true });
}
