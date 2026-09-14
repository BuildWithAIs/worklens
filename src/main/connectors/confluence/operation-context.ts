import type { ReadRequest } from "./schema";
import { summarizeItem } from "./list-results";
import { Continuations } from "./continuations";
import { lstat } from "node:fs/promises";
import { ConfluenceConnections, type ConnectionSnapshot } from "./connection";
import { ConfluenceAdapter } from "./adapter";
import { ServiceError, type Json } from "./http";
import {
  LocalArtifacts,
  fileIdentity,
  type Destination,
} from "../../local-artifacts";
export interface Execution {
  operations: OperationSupport;
  adapter: ConfluenceAdapter;
  connection: ConnectionSnapshot;
  sessionId: string;
  signal: AbortSignal;
}
export class OperationSupport {
  private continuations: Continuations;
  observed = new Map<string, number>();
  constructor(
    readonly connections: ConfluenceConnections,
    readonly artifacts: LocalArtifacts,
  ) {
    this.continuations = new Continuations(artifacts.root);
  }
  scope(a: ReadRequest) {
    const input: ReadRequest & { continuation?: string; limit?: number } = a;
    const { continuation: _c, limit: _l, ...query } = input;
    return JSON.stringify(query);
  }
  async list(
    ctx: Execution,
    a: ReadRequest & { continuation?: string; limit?: number },
    path: string,
  ) {
    const scope = this.scope(a);
    const owner = {
      scope,
      sessionId: ctx.sessionId,
      revision: ctx.connection.revision,
    };
    if (a.continuation)
      path = await this.continuations.resolve(owner, a.continuation);
    else path += (path.includes("?") ? "&" : "?") + `limit=${a.limit ?? 25}`;
    const response = await ctx.adapter.http.request(path);
    const data = await ctx.adapter.http.decode(response);
    if (!Array.isArray(data.results))
      throw new ServiceError(
        "invalid_response",
        "列表响应缺少 results，不能作为空结果处理",
      );
    const next =
      data._links?.next ??
      response.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
    const continuation = next
      ? await this.continuations.save(owner, ctx.adapter.http.nextPath(next))
      : undefined;
    return {
      items: data.results.map(summarizeItem),
      rawItems: data.results,
      itemsSummarized: true,
      complete: !continuation,
      continuation,
      ...(typeof data.totalSize === "number" ? { total: data.totalSize } : {}),
    };
  }
  observedKey(ctx: Execution, id: string) {
    return `${ctx.sessionId}:${ctx.connection.revision}:${id}`;
  }
  async page(
    ctx: Execution,
    a: { page: string; kind?: string; version?: number; status?: string },
    observe = false,
  ) {
    const page = await ctx.adapter.page(a.page, a.kind, a.version, a.status);
    if (observe && !a.version) {
      const key = this.observedKey(ctx, page.id);
      this.observed.delete(key);
      this.observed.set(key, page.version);
      if (this.observed.size > 2000)
        this.observed.delete(this.observed.keys().next().value!);
    }
    return page;
  }
  async property(
    ctx: Execution,
    a: { page: string; kind: string; key: string },
  ): Promise<Json> {
    const d = ctx.adapter;
    const id = d.http.pageId(a.page);
    if (!d.cloud)
      return d.http.json(
        d.v1(`/content/${id}/property/${encodeURIComponent(a.key)}`),
      );
    const result = await d.http.json(
      d.v2(
        `/${d.collection(a.kind)}/${id}/properties?key=${encodeURIComponent(a.key)}&limit=2`,
      ),
    );
    if (result.results?.length !== 1)
      throw new ServiceError("property_missing", "未找到唯一匹配的内容属性");
    return result.results[0];
  }
  async prepareDestination(
    destination?: Destination,
  ): Promise<Destination | undefined> {
    if (!destination?.overwrite || !destination.path) return destination;
    const path = this.artifacts.resolvePath(destination.path);
    const exists = await lstat(path).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
    if (!exists) return { ...destination, overwrite: false };
    if (!exists.isFile() || exists.isSymbolicLink())
      throw new Error("覆盖目标必须是普通文件");
    return { ...destination, expectedFile: fileIdentity(exists) };
  }
}
