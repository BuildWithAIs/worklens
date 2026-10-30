import type { ConfluenceHttp, Json } from "./http";

export function citationUrl(
  raw: Json,
  http: ConfluenceHttp,
): string | undefined {
  const content = raw.content ?? raw;
  for (const value of [
    raw.url,
    content.webuiLink,
    content._links?.webui,
    content.downloadLink,
    content._links?.download,
  ]) {
    if (typeof value !== "string" || !value.trim()) continue;
    try {
      const url = new URL(http.webUrl(value));
      if (url.protocol === "http:" || url.protocol === "https:")
        return url.href;
    } catch {
      // An unusable link must not discard the other search results.
    }
  }
  if (
    ["page", "blogpost"].includes(content.type) &&
    /^\d+$/.test(String(content.id ?? ""))
  )
    return http.webUrl(undefined, String(content.id));
}

/** Keep navigation and decision fields in context; full records remain in the retrieval file. */
export function summarizeItem(raw: Json, http: ConfluenceHttp): Json {
  const content = raw.content ?? raw;
  const excerpt =
    raw.excerpt ?? raw.body?.storage?.value ?? raw.body?.value ?? raw.text;
  return {
    id: content.id ?? raw.accountId ?? raw.userKey,
    type: content.type,
    title: content.title ?? raw.name ?? raw.displayName,
    key: raw.key,
    status: content.status,
    version: content.version?.number ?? raw.number,
    url: citationUrl(raw, http),
    space: content.space?.key ?? content.spaceId,
    pageId: raw.pageId ?? raw.blogPostId ?? raw.container?.id,
    ...(typeof excerpt === "string"
      ? {
          excerpt: excerpt.slice(0, 400),
          excerptTruncated: excerpt.length > 400,
        }
      : {}),
  };
}
export function assertNever(value: never): never {
  throw new Error(`Unhandled Confluence operation: ${JSON.stringify(value)}`);
}
