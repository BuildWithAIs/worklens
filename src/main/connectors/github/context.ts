import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { atomicJson } from "../../storage";
import type { LocalArtifacts } from "../../local-artifacts";
import type { GitHubConnections, ConnectionSnapshot } from "./connection";
import { GitHubHttp, ServiceError, type Json } from "./http";

export interface Context {
  connections: GitHubConnections;
  connection: ConnectionSnapshot;
  http: GitHubHttp;
  artifacts: LocalArtifacts;
  sessionId: string;
  signal: AbortSignal;
  mutate: (step: string, execute: () => Promise<any>) => Promise<any>;
}
export function repository(ctx: Context, target: string) {
  let value = target;
  if (/^https?:/i.test(target)) {
    const url = new URL(target);
    if (
      url.origin !== ctx.connection.settings.url ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new ServiceError(
        "invalid_target",
        "仓库 URL 不属于当前 GitHub 站点",
      );
    value = url.pathname.replace(/^\/|\/$/g, "");
  }
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(value) ||
    value.split("/").some((v) => /^\.+$/.test(v))
  )
    throw new ServiceError(
      "invalid_target",
      "请使用明确的 owner/repository 或本站仓库 URL",
    );
  const [owner, repo] = value.split("/");
  return { owner, repo };
}
export function params(ctx: Context, request: Json): Json {
  const { operation: _operation, repo, ...rest } = request;
  return { ...rest, ...(repo ? repository(ctx, repo) : {}) };
}
/** Explicit allowlist for a REST preflight; never put mutation payloads in URLs. */
export function targetParams(
  ctx: Context,
  request: Json,
  ...keys: string[]
): Json {
  return {
    ...repository(ctx, request.repo),
    ...Object.fromEntries(
      keys
        .filter((key) => request[key] !== undefined)
        .map((key) => [key, request[key]]),
    ),
  };
}
export function sessionDirectory(ctx: Context, kind: string) {
  return join(
    ctx.artifacts.root,
    "github",
    kind,
    createHash("sha256").update(ctx.sessionId).digest("hex"),
  );
}
export async function saveRecord(ctx: Context, kind: string, value: Json) {
  const id = randomUUID();
  await atomicJson(join(sessionDirectory(ctx, kind), `${id}.json`), {
    revision: ctx.connection.revision,
    expiresAt: Date.now() + 7 * 86400000,
    value: JSON.parse(ctx.connections.redact(JSON.stringify(value))),
  });
  return id;
}
export async function loadRecord(
  ctx: Context,
  kind: string,
  id: string,
): Promise<Json> {
  if (!z.uuid().safeParse(id).success)
    throw new ServiceError("invalid_continuation", "无效的续页或预览标识");
  try {
    const saved = JSON.parse(
      await readFile(join(sessionDirectory(ctx, kind), `${id}.json`), "utf8"),
    );
    if (
      saved.revision !== ctx.connection.revision ||
      saved.expiresAt < Date.now()
    )
      throw new Error();
    return saved.value;
  } catch {
    throw new ServiceError(
      "invalid_continuation",
      "续页或预览已过期，或不属于当前连接与会话",
    );
  }
}
export async function restWrite(
  ctx: Context,
  step: string,
  route: string,
  args: Json,
) {
  return ctx.mutate(
    step,
    async () => (await ctx.http.rest(route, args, false)).data,
  );
}
export async function graphWrite(
  ctx: Context,
  field: string,
  inputType: string,
  input: Json,
  selection: string,
) {
  return ctx.mutate(
    field,
    async () =>
      (
        await ctx.http.graphql(
          `mutation($input:${inputType}!){${field}(input:$input){${selection}}}`,
          { input },
          true,
        )
      )[field],
  );
}
export async function resource(
  ctx: Context,
  args: Json,
  type: "issue" | "pr" | "repository",
) {
  const p = targetParams(
    ctx,
    args,
    ...(type === "repository"
      ? []
      : [type === "issue" ? "issue_number" : "pull_number"]),
  );
  const suffix =
    type === "repository"
      ? ""
      : type === "issue"
        ? "/issues/{issue_number}"
        : "/pulls/{pull_number}";
  const response = await ctx.http.rest(`GET /repos/{owner}/{repo}${suffix}`, p);
  if (!response.data.node_id)
    throw new ServiceError("invalid_response", "GitHub 资源缺少 node ID");
  return response.data;
}
export async function node(
  ctx: Context,
  nodeId: string,
  type: string,
  fields: string,
) {
  const data = await ctx.http.graphql(
    `query($id:ID!){node(id:$id){__typename ... on ${type}{${fields}}}}`,
    { id: nodeId },
  );
  if (data.node?.__typename !== type)
    throw new ServiceError("invalid_target", `目标不是可访问的 ${type}`);
  return data.node;
}
export async function graphPage(
  ctx: Context,
  request: Json,
  connection: Json,
  metadata: Json = {},
) {
  const hasNextPage = connection?.pageInfo?.hasNextPage;
  if (
    !connection ||
    !Array.isArray(connection.nodes) ||
    typeof hasNextPage !== "boolean"
  )
    throw new ServiceError("invalid_response", "GitHub 未返回有效分页数据");
  const continuation = hasNextPage
    ? await saveRecord(ctx, "cursors", {
        ...request,
        after: connection.pageInfo.endCursor,
      })
    : undefined;
  return {
    status: "success",
    ...metadata,
    items: connection.nodes,
    complete: !hasNextPage,
    continuation,
  };
}
