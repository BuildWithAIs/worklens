import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, resolve } from "node:path";
import type { ConversationFile, MessageView } from "../shared/contracts";
import { isLocalReference, localReferences } from "../shared/file-references";
import { isWithin } from "./session-files";

export type FileContext = {
  cwd: string;
  roots: string[];
  messages: MessageView[];
};

function candidates(cwd: string, reference: string) {
  if (reference.startsWith("~/") || reference.startsWith("~\\"))
    return [resolve(homedir(), reference.slice(2))];
  const paths = [resolve(cwd, reference)];
  // Models sometimes report workspace/foo relative to the session, although
  // their actual working directory is already workspace. Prefer a real cwd path.
  if (
    basename(cwd) === "workspace" &&
    /^(?:workspace|artifacts)[\\/]/.test(reference)
  )
    paths.push(resolve(dirname(cwd), reference));
  return paths;
}

async function resolveReference(cwd: string, reference: string) {
  const paths = candidates(cwd, reference);
  for (const path of paths) {
    try {
      await stat(path);
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return path;
    }
  }
  return paths.at(-1)!;
}

function evidence(context: FileContext) {
  return context.messages.flatMap((message) => {
    if (message.role === "user") return localReferences(message.text);
    if (message.role !== "tool" || message.status !== "success") return [];
    const paths = [
      message.targetPath,
      ...(message.artifacts?.map((file) => file.path) ?? []),
    ].filter((path): path is string => !!path);
    // Shell tools lack structured file results. Only exact local paths in a
    // successful invocation/result count, never a whole parent directory.
    if (["bash", "powershell"].includes(message.toolName ?? "")) {
      paths.push(...localReferences(message.text));
      try {
        const args = JSON.parse(message.args ?? "{}");
        if (typeof args.command === "string")
          paths.push(...localReferences(args.command));
      } catch {
        /* unavailable/truncated arguments are not evidence */
      }
    }
    return paths;
  });
}

/** Output provenance is distinct from permission to inspect/read a file. */
async function wasProduced(context: FileContext, actual: string) {
  const outputs = context.messages.flatMap((message) => {
    if (message.role !== "tool" || message.status !== "success") return [];
    const paths = message.artifacts?.map((file) => file.path) ?? [];
    if (["write", "edit"].includes(message.toolName ?? "")) {
      if (message.targetPath) paths.push(message.targetPath);
      else {
        try {
          const args = JSON.parse(message.args ?? "{}");
          if (typeof args.path === "string") paths.push(args.path);
        } catch {
          /* Incomplete arguments are not output evidence. */
        }
      }
    }
    return paths;
  });
  for (const output of new Set(outputs)) {
    const resolved = await resolveReference(context.cwd, output);
    if ((await realpath(resolved).catch(() => resolved)) === actual)
      return true;
  }
  return false;
}

const imageTypes: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
};

export async function inspectConversationFile(
  context: FileContext,
  reference: string,
): Promise<ConversationFile> {
  if (!isLocalReference(reference))
    throw new Error("Invalid local file reference");
  // A renderer may only act on file references actually present in this chat.
  const references = context.messages
    .filter((m) => m.role === "assistant")
    .flatMap((m) => localReferences(m.text));
  if (!references.includes(reference))
    throw new Error("Unreferenced local file");
  const path = await resolveReference(context.cwd, reference);
  const extension = extname(path).toLowerCase();
  const kind = /\.html?$/.test(extension)
    ? "html"
    : imageTypes[extension]
      ? "image"
      : "file";
  const file: ConversationFile = { path, kind };
  const inside = context.roots.some(
    (root) => path === resolve(root) || isWithin(root, path),
  );
  if (
    !inside &&
    !(
      await Promise.all(
        evidence(context).map((value) => resolveReference(context.cwd, value)),
      )
    ).includes(path)
  )
    return { ...file, issue: "unassociated" };
  try {
    const actual = await realpath(path);
    // Canonicalize root aliases (e.g. macOS /tmp) while refusing redirected
    // files inside managed roots. External evidence authorizes this exact file.
    if (inside) {
      const roots = await Promise.all(
        context.roots.map((root) => realpath(root).catch(() => root)),
      );
      if (!roots.some((root) => actual === root || isWithin(root, actual)))
        return { ...file, issue: "unassociated" };
    }
    const info = await stat(actual);
    if (!info.isFile() && !info.isDirectory())
      return { ...file, issue: "unavailable" };
    return {
      path: actual,
      kind: info.isDirectory() ? "directory" : kind,
      ...((await wasProduced(context, actual)) ? { produced: true } : {}),
    };
  } catch (error) {
    return {
      ...file,
      issue:
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "missing"
          : "unavailable",
    };
  }
}

export async function previewConversationFile(
  file: ConversationFile,
): Promise<ConversationFile> {
  if (file.issue || !["html", "image"].includes(file.kind)) return file;
  const limit = file.kind === "html" ? 2 * 1024 * 1024 : 20 * 1024 * 1024;
  try {
    if (!isAbsolute(file.path)) throw new Error("Invalid path");
    const handle = await open(
      file.path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile()) return { ...file, issue: "unavailable" };
      if (info.size > limit) return { ...file, issue: "tooLarge" };
      const buffer = Buffer.alloc(limit + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const chunk = await handle.read(
          buffer,
          bytesRead,
          buffer.length - bytesRead,
          bytesRead,
        );
        if (!chunk.bytesRead) break;
        bytesRead += chunk.bytesRead;
      }
      if (bytesRead > limit) return { ...file, issue: "tooLarge" };
      const content = buffer.subarray(0, bytesRead);
      return {
        ...file,
        content:
          file.kind === "html"
            ? content.toString("utf8")
            : `data:${imageTypes[extname(file.path).toLowerCase()]};base64,${content.toString("base64")}`,
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    return {
      ...file,
      issue:
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "missing"
          : "unavailable",
    };
  }
}
