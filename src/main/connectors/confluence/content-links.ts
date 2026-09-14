import { DomUtils, parseDocument } from "htmlparser2";

type Node = ReturnType<typeof parseDocument>["children"][number];
export function attachmentReference(name: string) {
  return `attachment:${encodeURIComponent(name).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

/** Convert Confluence references without fetching every linked resource. */
export function storageLink(
  node: Node,
  raw: string,
  sourceUrl: string,
  siteUrl: string | undefined,
  escape: (value: string) => string,
  warnings: string[],
): string {
  if (node.type !== "tag") return "";
  const find = (name: string) =>
    DomUtils.findOne((n) => n.name === name, node.children, true);
  const attachment = find("ri:attachment");
  const page = find("ri:page");
  const url = find("ri:url");
  const body = find("ac:plain-text-link-body") ?? find("ac:link-body");
  const label = body ? DomUtils.textContent(body) : "";
  const anchor = node.attribs["ac:anchor"];
  const fallback = () => {
    warnings.push(
      "无法完整解析的 Confluence 链接已保留原文，请根据引用定位目标",
    );
    return `<pre><code>${escape(raw)}</code></pre>`;
  };
  const link = (href: string, text: string) =>
    `<a href="${escape(href)}">${escape(text)}</a>`;
  if (attachment) {
    // A nested container denotes another page's attachment, not a local asset.
    if (attachment.children.some((child) => child.type === "tag"))
      return fallback();
    const name = attachment.attribs["ri:filename"];
    if (!name) return fallback();
    return link(attachmentReference(name), label || name);
  }
  if (page) {
    const id = page.attribs["ri:content-id"];
    const title = page.attribs["ri:content-title"];
    const space = page.attribs["ri:space-key"];
    if (id && /^\d+$/.test(id) && siteUrl) {
      const target = new URL(`${siteUrl}/pages/viewpage.action`);
      target.searchParams.set("pageId", id);
      if (anchor) target.hash = anchor;
      return link(target.href, label || title || id);
    }
    if (title) {
      warnings.push(
        "部分内部页面链接仅含标题，已保留空间、标题和锚点；请搜索定位目标",
      );
      return `<span>${escape(label || title)}（Confluence 页面引用：${escape(JSON.stringify({ title, space, anchor }))}）</span>`;
    }
    return fallback();
  }
  if (url?.attribs["ri:value"]) {
    try {
      const target = new URL(url.attribs["ri:value"], sourceUrl);
      if (["https:", "http:", "mailto:"].includes(target.protocol))
        return link(target.href, label || target.href);
    } catch {
      /* Preserve unrecognized references below. */
    }
    return fallback();
  }
  if (
    anchor &&
    !node.children.some(
      (child) => child.type === "tag" && child.name.startsWith("ri:"),
    )
  ) {
    const target = new URL(sourceUrl);
    target.hash = anchor;
    return link(target.href, label || anchor);
  }
  return fallback();
}
