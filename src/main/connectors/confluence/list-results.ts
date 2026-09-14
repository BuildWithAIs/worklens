import type { Json } from "./http";

/** Keep navigation and decision fields in context; full records remain in the retrieval file. */
export function summarizeItem(raw: Json): Json {
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
    url: raw.url ?? content._links?.webui,
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
