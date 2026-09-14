import { Marked } from "marked";
import TurndownService from "turndown";
import { parseDocument, DomUtils } from "htmlparser2";
import { XMLValidator } from "fast-xml-parser";
import { ServiceError } from "./http";
import { storageLink, attachmentReference } from "./content-links";
export function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function supportedLink(value: string) {
  try {
    return ["https:", "http:", "mailto:"].includes(
      new URL(value, "https://relative.invalid/").protocol,
    );
  } catch {
    return false;
  }
}
function safeLink(value: string) {
  if (!supportedLink(value))
    throw new ServiceError("invalid_content", "内容包含不支持的链接协议");
  return escapeXml(value);
}
export interface AssetReference {
  source: string;
  name: string;
}
export function markdownStorage(
  markdown: string,
  assets: Record<string, string> = {},
): string {
  const parser = new Marked({
    gfm: true,
    async: false,
    renderer: {
      html({ text }) {
        return escapeXml(text);
      },
      code({ text, lang }) {
        return `<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">${escapeXml(lang?.split(" ")[0] || "text")}</ac:parameter><ac:plain-text-body><![CDATA[${text.replace(/]]>/g, "]]]]><![CDATA[>")}]]></ac:plain-text-body></ac:structured-macro>`;
      },
      image({ href, text }) {
        if (assets[href])
          return `<ac:image ac:alt="${escapeXml(text)}"><ri:attachment ri:filename="${escapeXml(assets[href])}"/></ac:image>`;
        if (!/^https?:\/\//i.test(href))
          throw new ServiceError(
            "missing_asset",
            `本地图片 ${href} 尚未上传，请使用 publish_markdown 并指定附件列表`,
          );
        return `<ac:image ac:alt="${escapeXml(text)}"><ri:url ri:value="${safeLink(href)}"/></ac:image>`;
      },
      link({ href, tokens }) {
        const label = this.parser.parseInline(tokens);
        if (assets[href])
          return `<ac:link><ri:attachment ri:filename="${escapeXml(assets[href])}"/><ac:plain-text-link-body><![CDATA[${DomUtils.textContent(parseDocument(label)).replace(/]]>/g, "]]]]><![CDATA[>")}]]></ac:plain-text-link-body></ac:link>`;
        return `<a href="${safeLink(href)}">${label}</a>`;
      },
    },
  });
  return (parser.parse(markdown) as string)
    .replace(/<br>/g, "<br/>")
    .replace(/<hr>/g, "<hr/>")
    .replace(/<input[^>]*>/g, "[ ]");
}
export function storageContent(
  content: string,
  format: "markdown" | "storage",
) {
  if (format === "markdown") content = markdownStorage(content);
  if (
    /<!DOCTYPE|<!ENTITY/i.test(content) ||
    XMLValidator.validate(`<root>${content}</root>`) !== true
  )
    throw new ServiceError(
      "invalid_content",
      "内容不是有效的 storage XHTML；未写入",
    );
  const nodes = parseDocument(content, { xmlMode: true }).children;
  const unsafe = DomUtils.findAll(
    (node) =>
      ["script", "iframe", "object", "embed"].includes(
        node.name.toLowerCase(),
      ) ||
      Object.entries(node.attribs).some(
        ([key, value]) =>
          /^on/i.test(key) ||
          (["href", "src", "ri:value"].includes(key) &&
            /^(?:javascript|vbscript|data):/i.test(value.trim())),
      ),
    nodes,
  );
  if (unsafe.length)
    throw new ServiceError("invalid_content", "不接受可执行 HTML 内容");
  return content;
}
export function readableStorage(
  storage: string,
  sourceUrl: string,
  siteUrl?: string,
): { markdown: string; warnings: string[] } {
  const warnings: string[] = [];
  // Preserve unknown macros verbatim as fenced source instead of silently dropping them.
  const document = parseDocument(storage, {
    xmlMode: true,
    withStartIndices: true,
    withEndIndices: true,
  });
  const replacements: { start: number; end: number; value: string }[] = [];
  function visit(nodes: typeof document.children) {
    for (const node of nodes) {
      if (node.type !== "tag") continue;
      if (node.name === "ac:structured-macro" || node.name === "ac:macro") {
        const name = node.attribs["ac:name"] || "unknown";
        const text = DomUtils.textContent(node);
        const raw = storage.slice(node.startIndex!, node.endIndex! + 1);
        const value =
          name === "code"
            ? `<pre><code>${escapeXml(DomUtils.findOne((n) => n.name === "ac:plain-text-body", node.children, true) ? DomUtils.textContent(DomUtils.findOne((n) => n.name === "ac:plain-text-body", node.children, true)!) : text)}</code></pre>`
            : `<p>[Confluence macro: ${escapeXml(name)}]</p><pre><code>${escapeXml(raw)}</code></pre>`;
        if (name !== "code")
          warnings.push(`宏 ${name} 以原文保留，未模拟其渲染结果`);
        replacements.push({
          start: node.startIndex!,
          end: node.endIndex! + 1,
          value,
        });
      } else if (node.name === "ac:link") {
        replacements.push({
          start: node.startIndex!,
          end: node.endIndex! + 1,
          value: storageLink(
            node,
            storage.slice(node.startIndex!, node.endIndex! + 1),
            sourceUrl,
            siteUrl,
            escapeXml,
            warnings,
          ),
        });
      } else if (node.name === "ac:image") {
        const attachment = DomUtils.findOne(
          (n) => n.name === "ri:attachment",
          node.children,
          true,
        );
        const url = DomUtils.findOne(
          (n) => n.name === "ri:url",
          node.children,
          true,
        );
        if (attachment?.children.some((child) => child.type === "tag")) {
          warnings.push("跨页面图片附件引用已保留原文，请根据容器页面定位附件");
          replacements.push({
            start: node.startIndex!,
            end: node.endIndex! + 1,
            value: `<pre><code>${escapeXml(storage.slice(node.startIndex!, node.endIndex! + 1))}</code></pre>`,
          });
          continue;
        }
        const src = attachment
          ? attachmentReference(attachment.attribs["ri:filename"] || "")
          : url?.attribs["ri:value"];
        replacements.push({
          start: node.startIndex!,
          end: node.endIndex! + 1,
          value: src
            ? `<img src="${escapeXml(src)}" alt="${escapeXml(node.attribs["ac:alt"] || attachment?.attribs["ri:filename"] || "image")}"/>`
            : "[Image unavailable]",
        });
      } else if (node.name === "ri:user") {
        const identity =
          node.attribs["ri:account-id"] ||
          node.attribs["ri:username"] ||
          node.attribs["ri:userkey"] ||
          "unknown";
        replacements.push({
          start: node.startIndex!,
          end: node.endIndex! + 1,
          value: `@${escapeXml(identity)}`,
        });
      } else visit(node.children);
    }
  }
  visit(document.children);
  for (const replacement of replacements.sort((a, b) => b.start - a.start))
    storage =
      storage.slice(0, replacement.start) +
      replacement.value +
      storage.slice(replacement.end);
  const converter = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
  });
  converter.addRule("table", {
    filter: "table",
    replacement(_content, node) {
      return "\n\n" + node.outerHTML + "\n\n";
    },
  });
  converter.addRule("links", {
    filter: "a",
    replacement(content, node) {
      const href = node.getAttribute("href");
      if (!href) return content;
      if (href.startsWith("attachment:")) return `[${content}](${href})`;
      try {
        const url = new URL(href, sourceUrl);
        return ["http:", "https:", "mailto:"].includes(url.protocol)
          ? `[${content}](${url.href})`
          : content;
      } catch {
        return content;
      }
    },
  });
  converter.remove(["script", "style", "iframe", "object"]);
  return {
    markdown: converter.turndown(storage),
    warnings: [...new Set(warnings)],
  };
}
export interface Edit {
  find: string;
  replace: string;
  expectedMatches: number;
}
export function applyEdits(storage: string, edits: Edit[]) {
  for (const edit of edits) {
    const count = storage.split(edit.find).length - 1;
    if (count !== edit.expectedMatches)
      throw new ServiceError(
        "ambiguous_edit",
        `预期匹配 ${edit.expectedMatches} 处，实际 ${count} 处；未写入。请读取 storage 格式并缩小匹配范围。`,
      );
    storage = storage.split(edit.find).join(edit.replace);
  }
  return storageContent(storage, "storage");
}
export function changePreview(before: string, after: string) {
  let start = 0;
  while (
    start < before.length &&
    start < after.length &&
    before[start] === after[start]
  )
    start++;
  let end = 0;
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  )
    end++;
  return {
    before: before.slice(
      Math.max(0, start - 160),
      end ? before.length - end + 160 : undefined,
    ),
    after: after.slice(
      Math.max(0, start - 160),
      end ? after.length - end + 160 : undefined,
    ),
  };
}

/** Render a portable, inert HTML document. Only formatting and safe resource links survive. */
export function exportHtml(markdown: string, title: string) {
  const html = new Marked({ gfm: true, async: false }).parse(
    markdown,
  ) as string;
  const tree = parseDocument(html);
  const allowed = new Set([
    "p",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "ul",
    "ol",
    "li",
    "pre",
    "code",
    "blockquote",
    "table",
    "thead",
    "tbody",
    "tr",
    "td",
    "th",
    "strong",
    "em",
    "del",
    "a",
    "img",
    "br",
    "hr",
  ]);
  const render = (nodes: typeof tree.children): string =>
    nodes
      .map((node): string => {
        if (node.type === "text") return escapeXml(node.data);
        if (node.type !== "tag") return "";
        if (!allowed.has(node.name)) return render(node.children);
        let attributes = "";
        if (node.name === "a" || node.name === "img") {
          const key = node.name === "a" ? "href" : "src";
          const value = node.attribs[key] || "";
          if (supportedLink(value) && !value.startsWith("//"))
            attributes = ` ${key}="${escapeXml(value)}"`;
          if (node.name === "img")
            attributes += ` alt="${escapeXml(node.attribs.alt || "")}"`;
        }
        return ["img", "br", "hr"].includes(node.name)
          ? `<${node.name}${attributes}>`
          : `<${node.name}${attributes}>${render(node.children)}</${node.name}>`;
      })
      .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: http: file:; style-src 'unsafe-inline'"><title>${escapeXml(title)}</title><style>body{max-width:900px;margin:40px auto;padding:0 24px;font:16px/1.6 system-ui}pre{white-space:pre-wrap;background:#f5f5f5;padding:16px}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:8px}img{max-width:100%}</style></head><body>${render(tree.children)}</body></html>`;
}
