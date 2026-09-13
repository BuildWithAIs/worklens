import { tmpdir } from "node:os";
import { open, realpath, mkdtemp, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join, extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { MessageView } from "../shared/contracts";

export async function readHtmlPreview(root: string, file: string, messages: MessageView[]) {
  const unavailable = () => new Error("HTML preview unavailable");
  if (!isAbsolute(file) || !/\.html?$/i.test(extname(file)) || file.includes("\0")) throw unavailable();
  if (!messages.some(message => message.role === "assistant" && (
    message.text.includes("`" + file + "`") || message.text.includes("](" + file + ")")
  ))) throw unavailable();
  const base = await realpath(root);
  const actual = await realpath(file);
  const within = (path: string) => { const part = relative(base, path); return !!part && part !== ".." && !part.startsWith(".." + sep) && !isAbsolute(part); };
  if (!within(actual) || actual !== resolve(file)) throw unavailable();
  const handle = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw unavailable();
    const buffer = Buffer.alloc(2 * 1024 * 1024 + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 2 * 1024 * 1024) throw unavailable();
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally { await handle.close(); }
}


export async function htmlActionFile(root: string, source: { path?: string; code?: string }, messages: MessageView[]) {
  if (source.path !== undefined) {
    if (source.code !== undefined) throw new Error("Invalid HTML source");
    await readHtmlPreview(root, source.path, messages);
    return source.path;
  }
  const code = source.code;
  if (!code || Buffer.byteLength(code) > 2 * 1024 * 1024 || !messages.some(message => message.role === "assistant" && message.text.includes(code)))
    throw new Error("HTML source unavailable");
  const directory = await mkdtemp(join(tmpdir(), "worklens-html-"));
  const file = join(directory, "web-preview.html");
  await writeFile(file, code, { mode: 0o600, flag: "wx" });
  return file;
}
