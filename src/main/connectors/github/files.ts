import { basename } from "node:path";
import { open } from "node:fs/promises";
import { parseDocument } from "yaml";
import {
  LocalArtifacts,
  MAX_FILE_BYTES,
  fileIdentity,
} from "../../local-artifacts";
import {
  type Context,
  params,
  targetParams,
  resource,
  restWrite,
  graphWrite,
} from "./context";
import { ServiceError, type Json } from "./http";

function gitRef(value: string) {
  if (
    !value ||
    /[\x00-\x20\x7f~^:?*\[\\]/.test(value) ||
    value.includes("..") ||
    value.includes("@{") ||
    value.endsWith(".") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.split("/").some((s) => !s || s.startsWith(".") || s.endsWith(".lock"))
  )
    throw new ServiceError("invalid_request", "无效的 Git ref");
  return value;
}
export async function fileOperation(
  ctx: Context,
  request: Json,
): Promise<Json | undefined> {
  const p = params(ctx, request);
  if (["create_branch", "create_tag"].includes(request.operation)) {
    const branch = request.operation === "create_branch";
    const { branch: _branch, tag: _tag, ...args } = p;
    return restWrite(
      ctx,
      request.operation,
      "POST /repos/{owner}/{repo}/git/refs",
      {
        ...args,
        ref: `refs/${branch ? "heads" : "tags"}/${gitRef(branch ? request.branch : request.tag)}`,
      },
    );
  }
  if (["delete_branch", "delete_tag"].includes(request.operation)) {
    const branch = request.operation === "delete_branch";
    const name = gitRef(branch ? request.branch : request.tag);
    if (branch) {
      const repository = await resource(ctx, request, "repository");
      const value = (
        await ctx.http.rest(
          "GET /repos/{owner}/{repo}/branches/{branch}",
          targetParams(ctx, request, "branch"),
        )
      ).data;
      if (repository.default_branch === name || value.protected)
        throw new ServiceError("permission", "不能删除默认分支或受保护分支");
    }
    const ref = `${branch ? "heads" : "tags"}/${name}`;
    const current = (
      await ctx.http.rest("GET /repos/{owner}/{repo}/git/ref/{ref}", {
        ...targetParams(ctx, request),
        ref,
      })
    ).data;
    if (current.object.sha !== (request.expectedHeadSha ?? request.expectedSha))
      throw new ServiceError("conflict", "Git ref 已变更");
    const result = await restWrite(
      ctx,
      request.operation,
      "DELETE /repos/{owner}/{repo}/git/refs/{ref}",
      { owner: p.owner, repo: p.repo, ref },
    );
    return {
      result,
      warning:
        "GitHub 删除 ref 接口不提供原子 SHA 条件；已在发送前校验，仍存在远端并发窗口。",
    };
  }
  if (request.operation === "commit_files") {
    gitRef(request.branch);
    const additions: Json[] = request.additions ?? [];
    const deletions: string[] = request.deletions ?? [];
    const paths = [...additions.map((a) => a.path), ...deletions];
    if (!paths.length || new Set(paths).size !== paths.length)
      throw new ServiceError(
        "invalid_request",
        "提交需要非空且不重复的文件路径",
      );
    const branch = (
      await ctx.http.rest(
        "GET /repos/{owner}/{repo}/branches/{branch}",
        targetParams(ctx, request, "branch"),
      )
    ).data;
    if (branch.commit.sha !== request.expectedHeadSha)
      throw new ServiceError("conflict", "分支已变更，请重新读取文件");
    return graphWrite(
      ctx,
      "createCommitOnBranch",
      "CreateCommitOnBranchInput",
      {
        branch: {
          repositoryNameWithOwner: `${p.owner}/${p.repo}`,
          branchName: request.branch,
        },
        expectedHeadOid: request.expectedHeadSha,
        message: { headline: request.message },
        fileChanges: {
          additions: additions.map((a) => ({
            path: a.path,
            contents: Buffer.from(a.contents).toString("base64"),
          })),
          deletions: deletions.map((path) => ({ path })),
        },
      },
      "commit{oid url} ref{name}",
    );
  }
  if (request.operation === "generate_release_notes")
    return (
      await ctx.http.rest(
        "POST /repos/{owner}/{repo}/releases/generate-notes",
        p,
        true,
      )
    ).data;
  if (["create_release", "update_release"].includes(request.operation)) {
    const current =
      request.operation === "update_release"
        ? (
            await ctx.http.rest(
              "GET /repos/{owner}/{repo}/releases/{release_id}",
              targetParams(ctx, request, "release_id"),
            )
          ).data
        : undefined;
    await ctx.http.rest("GET /repos/{owner}/{repo}/git/ref/{ref}", {
      owner: p.owner,
      repo: p.repo,
      ref: `tags/${gitRef(request.tag_name ?? current.tag_name)}`,
    });
    return restWrite(
      ctx,
      request.operation,
      request.operation === "create_release"
        ? "POST /repos/{owner}/{repo}/releases"
        : "PATCH /repos/{owner}/{repo}/releases/{release_id}",
      {
        ...(request.operation === "create_release" ? { draft: true } : {}),
        ...p,
      },
    );
  }
  if (request.operation === "upload_release_asset") {
    const file = await open(ctx.artifacts.resolvePath(request.path), "r");
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size > MAX_FILE_BYTES)
        throw new ServiceError(
          "invalid_file",
          "上传文件必须是小于 100 MiB 的普通文件",
        );
      if (request.expectedFile && fileIdentity(before) !== request.expectedFile)
        throw new ServiceError("conflict", "本地文件已变更");
      const chunks: Buffer[] = [];
      let length = 0;
      while (true) {
        ctx.signal.throwIfAborted();
        const chunk = Buffer.alloc(
          Math.min(1024 * 1024, MAX_FILE_BYTES + 1 - length),
        );
        const { bytesRead } = await file.read(chunk);
        if (!bytesRead) break;
        length += bytesRead;
        if (length > MAX_FILE_BYTES)
          throw new ServiceError("invalid_file", "上传文件超过 100 MiB");
        chunks.push(chunk.subarray(0, bytesRead));
      }
      const bytes = Buffer.concat(chunks);
      if (
        bytes.length > MAX_FILE_BYTES ||
        fileIdentity(await file.stat()) !== fileIdentity(before)
      )
        throw new ServiceError("conflict", "读取过程中本地文件发生变化");
      const name = request.name ?? basename(request.path);
      await ctx.http.rest(
        "GET /repos/{owner}/{repo}/releases/{release_id}",
        targetParams(ctx, request, "release_id"),
      );
      return ctx.mutate("upload_release_asset", () =>
        ctx.http.upload(
          `/repos/${encodeURIComponent(p.owner)}/${encodeURIComponent(p.repo)}/releases/${request.release_id}/assets`,
          name,
          bytes,
          request.contentType ?? "application/octet-stream",
        ),
      );
    } finally {
      await file.close();
    }
  }
  const downloads: Record<string, [string, string, string?]> = {
    download_file: [
      "GET /repos/{owner}/{repo}/contents/{path}",
      basename(request.path ?? "file"),
      "application/vnd.github.raw+json",
    ],
    download_artifact: [
      "GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}",
      `artifact-${request.artifact_id}.zip`,
    ],
    download_release_asset: [
      "GET /repos/{owner}/{repo}/releases/assets/{asset_id}",
      `asset-${request.asset_id}`,
    ],
    download_run_logs: [
      "GET /repos/{owner}/{repo}/actions/runs/{run_id}/logs",
      `run-${request.run_id}-logs.zip`,
    ],
    read_job_logs: [
      "GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs",
      `job-${request.job_id}.log`,
      "text/plain",
    ],
  };
  if (downloads[request.operation]) {
    const [route, defaultName, accept] = downloads[request.operation];
    let name = defaultName;
    if (request.operation === "download_release_asset")
      name = (
        await ctx.http.rest(
          "GET /repos/{owner}/{repo}/releases/assets/{asset_id}",
          targetParams(ctx, request, "asset_id"),
        )
      ).data.name;
    const { destination: target, ...args } = p;
    const response = await ctx.http.download(
      route,
      {
        ...args,
        ...(request.operation === "download_artifact"
          ? { archive_format: "zip" }
          : {}),
      },
      accept,
    );
    const artifact = await ctx.artifacts.save(
      ctx.sessionId,
      name,
      LocalArtifacts.stream(response),
      target,
      ctx.signal,
      "github",
    );
    return {
      artifacts: [artifact],
      complete: true,
      message: "文件已保存；压缩包未解压或执行。日志请读取文件并引用实际步骤。",
    };
  }
  if (request.operation === "dispatch_workflow") {
    const workflow = (
      await ctx.http.rest(
        "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}",
        targetParams(ctx, request, "workflow_id"),
      )
    ).data;
    if (workflow.state !== "active")
      throw new ServiceError("invalid_request", "工作流未启用");
    const ref = (
      await ctx.http.rest(
        "GET /repos/{owner}/{repo}/commits/{ref}",
        targetParams(ctx, request, "ref"),
      )
    ).data;
    const content = (
      await ctx.http.rest("GET /repos/{owner}/{repo}/contents/{path}", {
        owner: p.owner,
        repo: p.repo,
        path: workflow.path,
        ref: ref.sha,
      })
    ).data;
    if (
      content.encoding !== "base64" ||
      !content.content ||
      content.size > 1024 * 1024
    )
      throw new ServiceError("invalid_response", "无法读取工作流配置");
    const document = parseDocument(
      Buffer.from(content.content, "base64").toString("utf8"),
    );
    if (document.errors.length)
      throw new ServiceError("invalid_response", "工作流 YAML 无效");
    const yaml = document.toJS({ maxAliasCount: 50 });
    const trigger = yaml?.on;
    const dispatch =
      typeof trigger === "string"
        ? trigger === "workflow_dispatch"
        : Array.isArray(trigger)
          ? trigger.includes("workflow_dispatch")
          : trigger && Object.hasOwn(trigger, "workflow_dispatch");
    if (!dispatch)
      throw new ServiceError(
        "unsupported_capability",
        "工作流未配置 workflow_dispatch",
      );
    const fields =
      typeof trigger === "object"
        ? (trigger.workflow_dispatch?.inputs ?? {})
        : {};
    const inputs = request.inputs ?? {};
    for (const key of Object.keys(inputs))
      if (!Object.hasOwn(fields, key))
        throw new ServiceError("invalid_request", `未知工作流输入：${key}`);
    for (const [key, definition] of Object.entries(fields) as [
      string,
      Json,
    ][]) {
      const value = inputs[key] ?? definition.default;
      if (definition.required && (value === undefined || value === ""))
        throw new ServiceError("invalid_request", `缺少工作流输入：${key}`);
      if (value === undefined) continue;
      if (definition.type === "choice" && !definition.options?.includes(value))
        throw new ServiceError("invalid_request", `工作流选项无效：${key}`);
      if (
        definition.type === "boolean" &&
        ![true, false, "true", "false"].includes(value)
      )
        throw new ServiceError("invalid_request", `工作流布尔输入无效：${key}`);
      if (definition.type === "number" && !Number.isFinite(Number(value)))
        throw new ServiceError("invalid_request", `工作流数字输入无效：${key}`);
      if (definition.type === "environment")
        await ctx.http.rest(
          "GET /repos/{owner}/{repo}/environments/{environment_name}",
          { owner: p.owner, repo: p.repo, environment_name: String(value) },
        );
    }
    await restWrite(
      ctx,
      "dispatch_workflow",
      "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches",
      { ...p, inputs },
    );
    return {
      status: "accepted",
      ref: request.ref,
      inspectedSha: ref.sha,
      message:
        "已受理工作流触发，请查询运行记录确认最终结果；触发接口未提供 ref 的原子 SHA 条件。",
    };
  }
}
