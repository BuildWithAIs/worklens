import { ConfluenceHttp, ServiceError, type Json } from "./http";
export interface Page {
  id: string;
  title: string;
  type: "page" | "blogpost";
  version: number;
  storage: string;
  url: string;
  status: string;
  space: string;
  raw: Json;
}
export class ConfluenceAdapter {
  readonly cloud: boolean;
  constructor(readonly http: ConfluenceHttp) {
    this.cloud = http.connection.settings.deployment === "cloud";
  }
  v1(path: string) {
    return "/rest/api" + path;
  }
  v2(path: string) {
    return "/api/v2" + path;
  }
  collection(kind: string) {
    return kind === "blogpost" ? "blogposts" : "pages";
  }
  async page(
    target: string,
    kind = "page",
    version?: number,
    status = "current",
  ): Promise<Page> {
    const id = this.http.pageId(target);
    const historical =
      !this.cloud && version !== undefined && status === "current";
    const path = this.cloud
      ? this.v2(
          `/${this.collection(kind)}/${id}?body-format=storage${version ? `&version=${version}` : ""}&status=${status}`,
        )
      : this.v1(
          `/content/${id}?expand=body.storage,version,space,ancestors,history&status=${historical ? "historical" : status}${version ? `&version=${version}` : ""}`,
        );
    let raw: Json;
    try {
      raw = await this.http.json(path);
    } catch (error) {
      // The requested version may still be current rather than historical.
      if (
        !historical ||
        !(error instanceof ServiceError) ||
        error.status !== 404
      )
        throw error;
      const current = await this.page(target, kind);
      if (current.version !== version) throw error;
      return current;
    }
    if (
      !raw.id ||
      !Number.isInteger(raw.version?.number) ||
      typeof raw.body?.storage?.value !== "string"
    )
      throw new ServiceError(
        "invalid_response",
        "页面缺少版本或 storage 正文，不能可靠读取或编辑",
      );
    if (version !== undefined && raw.version.number !== version)
      throw new ServiceError(
        "invalid_response",
        "服务返回的版本与请求不一致，未使用该正文",
      );
    return {
      id: String(raw.id),
      title: raw.title,
      type: raw.type ?? kind,
      version: raw.version.number,
      storage: raw.body.storage.value,
      url: this.http.webUrl(raw._links?.webui, raw.id),
      status: raw.status,
      space: raw.space?.key ?? raw.spaceId,
      raw,
    };
  }
  assertVersion(actual: number, expected: number) {
    if (actual !== expected)
      throw new ServiceError(
        "conflict",
        `版本冲突：预期 ${expected}，当前 ${actual}。未修改，请重新读取。`,
      );
  }
  async update(
    page: Page,
    storage: string,
    title = page.title,
    message = "Updated with WorkLens",
    minorEdit = false,
  ) {
    const version = { number: page.version + 1, message, minorEdit };
    return this.cloud
      ? this.http.json(
          this.v2(`/${this.collection(page.type)}/${page.id}`),
          "PUT",
          {
            id: page.id,
            title,
            status: "current",
            body: { representation: "storage", value: storage },
            version,
          },
        )
      : this.http.json(this.v1(`/content/${page.id}`), "PUT", {
          type: page.type,
          title,
          body: { storage: { representation: "storage", value: storage } },
          version,
        });
  }
  async space(space: string) {
    if (!this.cloud)
      return this.http.json(
        this.v1(
          `/space/${encodeURIComponent(space)}?expand=homepage,description.plain`,
        ),
      );
    if (/^\d+$/.test(space)) return this.http.json(this.v2(`/spaces/${space}`));
    const result = await this.http.json(
      this.v2(`/spaces?keys=${encodeURIComponent(space)}&limit=2`),
    );
    if (result.results?.length !== 1)
      throw new ServiceError(
        "ambiguous_target",
        "未找到唯一匹配的空间，请使用 list_spaces 返回的 ID",
      );
    return result.results[0];
  }
  async create(space: Json, input: Json, storage: string) {
    const kind = input.kind ?? "page";
    return this.cloud
      ? this.http.json(this.v2(`/${this.collection(kind)}`), "POST", {
          spaceId: String(space.id),
          status: input.status ?? "current",
          title: input.title,
          ...(input.parentId && kind === "page"
            ? { parentId: input.parentId }
            : {}),
          body: { representation: "storage", value: storage },
        })
      : this.http.json(this.v1("/content"), "POST", {
          type: kind,
          title: input.title,
          status: input.status ?? "current",
          space: { key: space.key },
          ...(input.parentId && kind === "page"
            ? { ancestors: [{ id: input.parentId }] }
            : {}),
          body: { storage: { representation: "storage", value: storage } },
        });
  }
  async comment(id: string, kind: string) {
    return this.http.json(
      this.cloud
        ? this.v2(`/${kind}-comments/${id}?body-format=storage`)
        : this.v1(
            `/content/${id}?expand=body.storage,version,container,ancestors`,
          ),
    );
  }
  async attachment(id: string) {
    return this.http.json(
      this.cloud
        ? this.v2(`/attachments/${id}`)
        : this.v1(`/content/${id}?expand=version,container`),
    );
  }
  async upload(
    pageId: string,
    name: string,
    blob: Blob,
    attachmentId?: string,
    comment?: string,
  ) {
    const form = new FormData();
    form.append("file", blob, name);
    form.append("minorEdit", "true");
    if (comment) form.append("comment", comment);
    return this.http.json(
      this.v1(
        `/content/${pageId}/child/attachment${attachmentId ? `/${attachmentId}/data` : ""}`,
      ),
      "POST",
      form,
    );
  }
  async download(id: string) {
    if (this.cloud) {
      const raw = await this.attachment(id);
      const pageId = raw.pageId ?? raw.blogPostId;
      if (!pageId)
        throw new ServiceError("unsupported", "此附件容器暂不支持下载");
      return this.http.download(
        this.v1(`/content/${pageId}/child/attachment/${id}/download`),
      );
    }
    const raw = await this.attachment(id);
    const link = raw._links?.download;
    if (typeof link !== "string")
      throw new ServiceError("invalid_response", "附件缺少下载地址");
    const url = new URL(this.http.webUrl(link));
    const base = new URL(this.http.base);
    const prefix = base.pathname.replace(/\/$/, "");
    if (url.origin !== base.origin || !url.pathname.startsWith(prefix + "/"))
      throw new ServiceError("invalid_target", "附件下载地址不属于此连接");
    return this.http.download(url.pathname.slice(prefix.length) + url.search);
  }
}
