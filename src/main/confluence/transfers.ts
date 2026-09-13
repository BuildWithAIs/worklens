import type { ReadRequest, WriteOperation } from "./schema";
import type { Execution } from "./operation-context";
import { ServiceError, type Json } from "./http";
import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { LocalArtifact } from "../../shared/contracts";
import {
  LocalArtifacts,
  MAX_FILE_BYTES,
  safeFilename,
} from "../local-artifacts";
import { readableStorage, markdownStorage, exportHtml } from "./content";
export async function uploadFile(
  ctx: Execution,
  path: string,
): Promise<{ blob: Blob; name: string }> {
  const handle = await open(ctx.operations.artifacts.resolvePath(path), "r");
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > MAX_FILE_BYTES)
      throw new Error("上传目标必须是 100 MiB 以内的普通文件");
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let total = 0;
    for (;;) {
      const chunk = new Uint8Array(64 * 1024);
      const { bytesRead } = await handle.read(chunk);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > MAX_FILE_BYTES) throw new Error("文件超过 100 MiB 限制");
      chunks.push(chunk.slice(0, bytesRead));
    }
    return {
      blob: new Blob(chunks),
      name: safeFilename(basename(path)),
    };
  } finally {
    await handle.close();
  }
}
export async function exportPage(
  ctx: Execution,
  a: Extract<ReadRequest, { operation: "export_page" }>,
) {
  const p = await ctx.operations.page(ctx, a, true);
  const destination = await ctx.operations.authorizeLocal(ctx, a.destination);
  const directory = destination?.path
    ? dirname(ctx.operations.artifacts.resolvePath(destination.path))
    : destination?.directory
      ? join(
          ctx.operations.artifacts.resolvePath(destination.directory),
          `${safeFilename(p.title)}-${randomUUID().slice(0, 8)}`,
        )
      : await ctx.operations.artifacts.directory(ctx.sessionId);
  const assetsDirectory = join(directory, `assets-${randomUUID().slice(0, 8)}`);
  const artifacts: LocalArtifact[] = [];
  const failures: Json[] = [];
  const readable = readableStorage(p.storage, p.url);
  let markdown = readable.markdown;
  for (const id of a.attachmentIds) {
    if (ctx.signal.aborted) {
      failures.push({ attachmentId: id, error: "已取消，未下载" });
      continue;
    }
    try {
      const raw = await ctx.adapter.attachment(id);
      if (String(raw.pageId ?? raw.blogPostId ?? raw.container?.id) !== p.id)
        throw new ServiceError("invalid_target", "附件不属于此页面");
      const artifact = await ctx.operations.artifacts.save(
        ctx.sessionId,
        raw.title,
        LocalArtifacts.stream(await ctx.adapter.download(id)),
        { directory: assetsDirectory },
        ctx.signal,
      );
      artifacts.push(artifact);
      markdown = markdown
        .split(`attachment:${encodeURIComponent(raw.title)}`)
        .join(
          `${basename(assetsDirectory)}/${encodeURIComponent(artifact.name)}`,
        );
    } catch (e) {
      failures.push({
        attachmentId: id,
        error: e instanceof Error ? e.message : "下载失败",
      });
    }
  }
  markdown = markdown.replace(/attachment:[^)\s]+/g, p.url);
  const header = `# ${p.title}\n\nSource: ${p.url}\nVersion: ${p.version}\nExported: ${new Date().toISOString()}\n\n`;
  const text =
    a.format === "html"
      ? exportHtml(header + markdown, p.title)
      : header + markdown;
  if (ctx.signal.aborted)
    return {
      status: "partial",
      pageId: p.id,
      url: p.url,
      artifacts,
      failures,
      message: "导出已取消；已下载的附件保留，正文尚未保存。",
    };
  try {
    const artifact = await ctx.operations.artifacts.save(
      ctx.sessionId,
      `${safeFilename(p.title)}.${a.format === "html" ? "html" : "md"}`,
      text,
      destination?.path ? destination : { directory },
      ctx.signal,
    );
    artifacts.unshift(artifact);
  } catch (error) {
    return {
      status: "partial",
      pageId: p.id,
      version: p.version,
      url: p.url,
      artifacts,
      failures: [
        ...failures,
        {
          resource: "document",
          code: ctx.signal.aborted ? "cancelled" : "storage_error",
          error:
            error instanceof Error ? error.message : "Document save failed",
        },
      ],
      message:
        "正文未保存，已下载附件保留。可使用相同目标且 attachmentIds=[] 重试正文导出；不要重复下载成功附件。",
    };
  }
  return {
    status: failures.length ? "partial" : "success",
    artifacts,
    failures,
    warnings: [
      ...readable.warnings,
      "仅下载明确选定的附件，其余附件引用指向源页面。HTML 导出保留基本格式，禁用脚本。",
    ],
    pageId: p.id,
    version: p.version,
    url: p.url,
  };
}
export async function publishMarkdown(
  ctx: Execution,
  a: WriteOperation<"publish_markdown">,
  space: Json,
  dispatch: (fn: () => Promise<Json>) => Promise<Json>,
) {
  const document = await uploadFile(ctx, a.filePath);
  if (document.blob.size > 2 * 1024 * 1024)
    throw new Error("Markdown 文档不得超过 2 MiB");
  const markdown = await document.blob.text();
  const files: { reference: string; blob: Blob; name: string }[] = [];
  const mappings: Record<string, string> = {};
  for (const entry of a.assets) {
    const file = await uploadFile(ctx, entry.filePath);
    if (
      files.some((f) => f.name === file.name || f.reference === entry.reference)
    )
      throw new Error("附件文件名或引用重复，请先消除歧义");
    if (
      files.reduce((sum, item) => sum + item.blob.size, 0) + file.blob.size >
      MAX_FILE_BYTES
    )
      throw new Error("一次发布的附件总量不得超过 100 MiB");
    files.push({ ...file, reference: entry.reference });
    mappings[entry.reference] = file.name;
  }
  const storage = markdownStorage(markdown, mappings);
  await ctx.operations.approve(ctx, "publish_markdown", space.name, {
    title: a.title,
    parentId: a.parentId,
    storage,
    files: files.map((f) => ({ name: f.name, size: f.blob.size })),
    note: "先创建页面，再上传附件；失败时保留页面和成功附件，返回逐项结果。",
  });
  return dispatch(async () => {
    const created = await ctx.adapter.create(
      space,
      { ...a, status: "current" },
      storage,
    );
    const results: Json[] = [];
    for (const file of files) {
      try {
        ctx.signal.throwIfAborted();
        results.push({
          name: file.name,
          status: "success",
          result: await ctx.adapter.upload(
            String(created.id),
            file.name,
            file.blob,
          ),
        });
      } catch (e) {
        results.push({
          name: file.name,
          status: e instanceof ServiceError ? e.code : "failed",
          message: e instanceof Error ? e.message : "上传失败",
        });
      }
    }
    return {
      status: results.some((r) => r.status !== "success")
        ? "partial"
        : "success",
      pageId: created.id,
      url: ctx.adapter.http.webUrl(created._links?.webui, created.id),
      attachments: results,
      message: "页面与已上传附件已保留。失败附件可单独补传，不要重复发布页面。",
    };
  });
}
