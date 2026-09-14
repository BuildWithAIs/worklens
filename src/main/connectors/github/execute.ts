import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { operations } from "./catalog";
import {
  type Context,
  params,
  targetParams,
  saveRecord,
  loadRecord,
  sessionDirectory,
} from "./context";
import { ServiceError, type Json } from "./http";
import { reviewOperation } from "./reviews";
import { projectOperation } from "./projects";
import { collaborationOperation } from "./collaboration";
import { fileOperation } from "./files";

export function parseRequest(raw: unknown, write: boolean): Json {
  const outer = z
    .object({ request: z.record(z.string(), z.unknown()) })
    .strict()
    .parse(raw);
  const name = outer.request.operation;
  if (typeof name !== "string" || !Object.hasOwn(operations, name))
    throw new ServiceError(
      "invalid_request",
      "未知 GitHub 操作，请先查询 capabilities",
    );
  const operation = operations[name];
  if (operation.write !== write)
    throw new ServiceError(
      "invalid_request",
      `请使用 github_${operation.write ? "write" : "read"}`,
    );
  return operation.schema.parse(outer.request);
}
export async function execute(ctx: Context, request: Json): Promise<Json> {
  const operation = operations[request.operation];
  if (request.operation === "capabilities")
    return {
      status: "success",
      operations: Object.entries(operations).map(([name, op]) => ({
        name,
        write: op.write,
        description: op.description,
      })),
      site: ctx.connection.settings.url,
      login: ctx.connection.settings.login,
      serverVersion: ctx.connection.settings.serverVersion,
      caveats: [
        "Operations listed are implemented, not proof of account permissions or server support.",
        "Enterprise versions, token permissions, enabled features and repository rules can limit availability. A 404 may hide a resource; it does not prove lack of server support.",
        "GitHub search caps matches at 1000; file lists and patches may be capped independently.",
        "No arbitrary API routes, GraphQL documents, host switching, shell execution or organization administration.",
      ],
    };
  if (request.operation === "describe_operation") {
    const op = Object.hasOwn(operations, request.name)
      ? operations[request.name]
      : undefined;
    if (!op) throw new ServiceError("invalid_request", "未知操作");
    return {
      status: "success",
      name: request.name,
      write: op.write,
      description: op.description,
      schema: z.toJSONSchema(op.schema, { unrepresentable: "any" }),
    };
  }
  if (request.operation === "continue")
    return execute(ctx, await loadRecord(ctx, "cursors", request.continuation));
  if (request.operation === "read_operation") {
    try {
      const data = JSON.parse(
        await readFile(
          join(
            sessionDirectory(ctx, "operations"),
            `${request.operationId}.json`,
          ),
          "utf8",
        ),
      );
      if (data.revision !== ctx.connection.revision) throw new Error();
      return data;
    } catch {
      throw new ServiceError(
        "invalid_target",
        "写入记录不存在或不属于当前连接与会话",
      );
    }
  }
  if (request.operation === "preview_batch") {
    const numbers = [...new Set(request.issue_numbers)] as number[];
    const targets = [];
    for (const number of numbers) {
      const data = (
        await ctx.http.rest("GET /repos/{owner}/{repo}/issues/{issue_number}", {
          ...targetParams(ctx, request),
          issue_number: number,
        })
      ).data;
      if (data.pull_request)
        throw new ServiceError("invalid_target", "批量 Issue 操作不接受 PR");
      const candidate = {
        operation: request.action,
        repo: request.repo,
        issue_number: number,
        ...request.changes,
      };
      const parsed = parseRequest({ request: candidate }, true);
      targets.push({
        request: parsed,
        updatedAt: data.updated_at,
        title: data.title,
        url: data.html_url,
      });
    }
    return {
      status: "success",
      preview: await saveRecord(ctx, "previews", { targets }),
      targets,
      message: "仅对这些明确目标执行；执行前将再次核对更新时间。",
    };
  }
  if (request.operation === "batch") {
    const preview = await loadRecord(ctx, "previews", request.preview);
    const items: Json[] = [];
    for (const target of preview.targets) {
      ctx.signal.throwIfAborted();
      try {
        const current = (
          await ctx.http.rest(
            "GET /repos/{owner}/{repo}/issues/{issue_number}",
            targetParams(ctx, target.request, "issue_number"),
          )
        ).data;
        if (current.updated_at !== target.updatedAt)
          throw new ServiceError("conflict", "目标在预览后已变更");
        items.push({
          issue: target.request.issue_number,
          ...(await execute(ctx, target.request)),
        });
      } catch (e) {
        items.push({
          issue: target.request.issue_number,
          status: e instanceof ServiceError ? e.code : "unknown",
          message: e instanceof Error ? e.message : String(e),
        });
        if (ctx.signal.aborted) break;
      }
    }
    const succeeded = items.filter((i) => i.status === "success").length;
    return {
      status:
        succeeded === preview.targets.length
          ? "success"
          : succeeded
            ? "partial"
            : "failed",
      items,
      complete: items.length === preview.targets.length,
      recovery:
        "Prepare a new batch only for failed items. Verify unknown items remotely first.",
    };
  }
  for (const handler of [
    reviewOperation,
    projectOperation,
    collaborationOperation,
    fileOperation,
  ]) {
    const value = await handler(ctx, request);
    if (value !== undefined) {
      if (["success", "accepted", "partial"].includes(value.status))
        return value;
      return {
        status: "success",
        data: value,
        ...(value.artifacts ? { artifacts: value.artifacts } : {}),
      };
    }
  }
  if (!operation.route)
    throw new ServiceError("not_implemented", "操作未连接到执行器");
  const p: Json = {
    ...operation.defaults,
    ...params(ctx, request),
    ...(operation.paginated
      ? { per_page: request.per_page ?? 30, page: request.page ?? 1 }
      : {}),
  };
  if (request.operation === "search_prs") p.q = `${request.q} is:pr`;
  const result = operation.write
    ? await ctx.mutate(request.operation, () =>
        ctx.http.rest(operation.route!, p, false),
      )
    : await ctx.http.rest(operation.route, p, true);
  if (operation.write)
    return {
      status:
        operation.accepted || result.status === 202 ? "accepted" : "success",
      data: result.data,
      ...(operation.accepted
        ? { message: "请求已受理，请读取目标确认最终状态。" }
        : {}),
    };
  const data = result.data;
  let continuation: string | undefined;
  const warnings: string[] = [];
  const link = result.headers.link;
  const next = link
    ?.split(",")
    .find((part: string) => /rel="next"/.test(part))
    ?.match(/<([^>]+)>/)?.[1];
  if (next && operation.paginated) {
    const url = new URL(next);
    const base = new URL(ctx.http.addresses.rest);
    const nextPage = Number(url.searchParams.get("page"));
    if (
      url.origin !== base.origin ||
      !url.pathname.startsWith(base.pathname.replace(/\/$/, "") + "/") ||
      !Number.isSafeInteger(nextPage) ||
      nextPage <= p.page ||
      nextPage > 10000
    )
      throw new ServiceError(
        "invalid_continuation",
        "GitHub 返回了不可信或无效的分页链接",
      );
    continuation = await saveRecord(ctx, "cursors", {
      ...request,
      page: nextPage,
      per_page: p.per_page,
    });
  }
  if (request.operation.startsWith("search_") && data.total_count > 1000)
    warnings.push(
      "Search is capped at 1000 matches; narrow qualifiers to retrieve the rest.",
    );
  if (data.incomplete_results)
    warnings.push("GitHub reported incomplete search results.");
  if (data.truncated)
    warnings.push("GitHub truncated the tree; query smaller subtrees.");
  if (["pr_files", "read_commit", "compare"].includes(request.operation))
    warnings.push(
      "GitHub can omit/truncate patches and cap changed files; absence of a patch is not evidence of no change. Read content at exact SHAs for full context.",
    );
  if (
    request.operation === "pr_commits" &&
    ((request.page ?? 1) - 1) * p.per_page + data.length >= 250
  )
    warnings.push("PR commit listing may be capped at 250 commits.");
  return {
    status: "success",
    data,
    complete: !continuation && !warnings.length,
    continuation,
    warnings,
    pagination: operation.paginated
      ? {
          page: p.page,
          perPage: p.per_page,
          totalCount: data.total_count,
          count: Array.isArray(data)
            ? data.length
            : operation.collection
              ? data[operation.collection]?.length
              : undefined,
        }
      : undefined,
  };
}
