import { JiraHttp, ServiceError, type Json } from "./http";

export const segment = (value: string) => encodeURIComponent(value);
export function query(path: string, values: Json) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value !== undefined) params.set(key, String(value));
  return path + (path.includes("?") ? "&" : "?") + params;
}
export class JiraAdapter {
  readonly cloud: boolean;
  readonly api: string;
  readonly agile = "/rest/agile/1.0";
  constructor(readonly http: JiraHttp) {
    this.cloud = http.connection.settings.deployment === "cloud";
    this.api = `/rest/api/${this.cloud ? 3 : 2}`;
  }
  issuePath(issue: string) {
    return `${this.api}/issue/${segment(this.http.issueId(issue))}`;
  }
  get(path: string) {
    return this.http.json(path);
  }
  async issue(issue: string, fields?: string[]): Promise<Json> {
    const data = await this.get(
      query(this.issuePath(issue), {
        fields: fields?.join(","),
        expand: fields ? undefined : "names,schema",
      }),
    );
    if (
      typeof data.id !== "string" ||
      typeof data.key !== "string" ||
      !data.fields ||
      typeof data.fields !== "object"
    )
      throw new ServiceError(
        "invalid_response",
        "Jira 工单响应缺少 id/key/fields",
      );
    return { ...data, url: this.http.webUrl(data.key) };
  }
  /** Supports token, offset, and genuinely unpaged endpoints; never invents a total. */
  async page(
    path: string,
    limit: number,
    cursor: Json = {},
    key?: string,
    body?: Json,
    unpaged = false,
  ): Promise<Json> {
    let data: Json;
    if (body) {
      const params = this.cloud
        ? { nextPageToken: cursor.token }
        : { startAt: cursor.offset ?? 0 };
      data = await this.http.json(
        path,
        "POST",
        { ...body, ...params, maxResults: limit },
        true,
      );
    } else
      data = await this.get(
        unpaged
          ? path
          : query(path, { startAt: cursor.offset ?? 0, maxResults: limit }),
      );
    const rows = Array.isArray(data) ? data : key ? data[key] : data.values;
    if (!Array.isArray(rows))
      throw new ServiceError(
        "invalid_response",
        "列表响应缺少条目，不能视为空结果",
      );
    if (unpaged) {
      const offset = cursor.offset ?? 0;
      return {
        items: rows.slice(offset, offset + limit),
        total: rows.length,
        next:
          offset + limit < rows.length ? { offset: offset + limit } : undefined,
      };
    }
    const offset = Number(data.startAt ?? cursor.offset ?? 0);
    const total = typeof data.total === "number" ? data.total : undefined;
    let next: Json | undefined;
    if (
      typeof data.nextPageToken === "string" &&
      data.nextPageToken &&
      data.isLast !== true
    )
      next = { token: data.nextPageToken };
    else if (
      data.isLast === false ||
      (total !== undefined && offset + rows.length < total) ||
      (data.isLast === undefined &&
        total === undefined &&
        rows.length >= Number(data.maxResults ?? limit) &&
        !(this.cloud && body?.jql))
    )
      next = { offset: offset + rows.length };
    if (body?.jql && this.cloud && data.isLast !== true && !next)
      throw new ServiceError(
        "invalid_response",
        "Cloud 搜索响应缺少分页完成标识",
      );
    if (
      next &&
      (!rows.length || JSON.stringify(next) === JSON.stringify(cursor))
    )
      throw new ServiceError("invalid_response", "Jira 分页未前进，请重新查询");
    return { items: rows, total, next };
  }
  async all(path: string, key?: string, unpaged = false): Promise<Json[]> {
    let cursor: Json = {};
    const items: Json[] = [];
    for (let n = 0; n < 100; n++) {
      const page = await this.page(path, 100, cursor, key, undefined, unpaged);
      items.push(...page.items);
      if (!page.next) return items;
      cursor = page.next;
    }
    throw new ServiceError(
      "limit",
      "数据超过 10000 条，请缩小范围；未执行修改",
    );
  }
  async metadata(project: string, type: string) {
    const path = `${this.api}/issue/createmeta/${segment(project)}/issuetypes/${segment(type)}`;
    const rows = await this.all(path, this.cloud ? "fields" : "values");
    return Object.fromEntries(rows.map((f) => [f.fieldId ?? f.key, f]));
  }
  async validateFields(
    fields: Json,
    metadata: Json,
    creating = false,
    updates: Json = {},
  ) {
    if (creating)
      for (const [key, meta] of Object.entries<Json>(metadata)) {
        if (
          meta.required &&
          !meta.hasDefaultValue &&
          !(key in fields) &&
          !(key in updates)
        )
          throw new ServiceError(
            "required_field",
            `缺少必填字段 ${meta.name} (${key})`,
          );
      }
    for (const [key, values] of Object.entries<Json[]>(updates)) {
      const meta = metadata[key];
      if (!meta)
        throw new ServiceError(
          "invalid_field",
          `字段 ${key} 不可编辑或不在当前表单中`,
        );
      for (const value of values)
        for (const [action, entry] of Object.entries(value)) {
          if (!meta.operations?.includes(action))
            throw new ServiceError(
              "invalid_field",
              `字段 ${key} 不支持 ${action}`,
            );
          if (action === "set") this.validateValue(key, entry, meta);
          else
            this.validateValue(
              key,
              meta.schema?.type === "array" ? [entry] : entry,
              meta,
            );
        }
    }
    for (const [key, value] of Object.entries(fields)) {
      const meta = metadata[key];
      if (!meta)
        throw new ServiceError(
          "invalid_field",
          `字段 ${key} 不在当前创建/编辑表单中，请先读取 metadata`,
        );
      if (meta.operations && !meta.operations.includes("set"))
        throw new ServiceError("invalid_field", `字段 ${key} 不支持 set`);
      this.validateValue(key, value, meta);
    }
  }
  private validateValue(key: string, value: unknown, meta: Json) {
    if (
      value === null ||
      value === "" ||
      (Array.isArray(value) && !value.length)
    ) {
      if (meta.required)
        throw new ServiceError("required_field", `必填字段 ${key} 不能清空`);
      return;
    }
    const type = meta.schema?.type;
    if (
      (type === "number" && typeof value !== "number") ||
      (type === "array" && !Array.isArray(value)) ||
      (type === "string" &&
        typeof value !== "string" &&
        !(
          this.cloud &&
          ["description", "environment"].includes(key) &&
          (value as Json)?.type === "doc"
        ) &&
        !(
          this.cloud &&
          meta.schema?.custom?.endsWith(":textarea") &&
          (value as Json)?.type === "doc"
        ))
    )
      throw new ServiceError("invalid_field", `字段 ${key} 应为 ${type}`);
    if (
      type === "user" &&
      (typeof value !== "object" ||
        !(this.cloud ? (value as Json).accountId : (value as Json).name))
    )
      throw new ServiceError(
        "invalid_user",
        `字段 ${key} 需要准确的 ${this.cloud ? "accountId" : "username"}`,
      );
    if (
      type === "array" &&
      meta.schema?.items === "string" &&
      !(value as unknown[]).every((v) => typeof v === "string")
    )
      throw new ServiceError("invalid_field", `字段 ${key} 需要字符串数组`);
    if (Array.isArray(meta.allowedValues) && meta.allowedValues.length) {
      for (const entry of Array.isArray(value) ? value : [value]) {
        const v = entry as Json;
        const matches = meta.allowedValues.filter((option: Json) =>
          typeof entry === "object" && entry !== null
            ? v.id !== undefined
              ? String(option.id) === String(v.id)
              : v.accountId !== undefined
                ? option.accountId === v.accountId
                : v.key !== undefined
                  ? option.key === v.key
                  : v.value !== undefined
                    ? option.value === v.value
                    : v.name !== undefined && option.name === v.name
            : option.value === entry || option.name === entry,
        );
        if (matches.length !== 1)
          throw new ServiceError(
            "invalid_field",
            `字段 ${key} 的值无效或有歧义，请使用 metadata 中的唯一 ID`,
          );
      }
    }
  }
  async checkIssue(issue: string, expected?: string) {
    const current = await this.issue(issue, ["updated"]);
    if (expected && current.fields.updated !== expected)
      throw new ServiceError(
        "conflict",
        "工单已变更，请重新读取目标并准备修改",
      );
    return current;
  }
}
