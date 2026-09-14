import { marked } from "marked";
import type { DocumentInput } from "./schema";
import { ServiceError, type Json } from "./http";

/** Convert only explicitly authored content. Native documents are never round-tripped on reads. */
export function encodeDocument(input: DocumentInput, cloud: boolean): unknown {
  if (input.format === "adf") {
    if (!cloud)
      throw new ServiceError(
        "invalid_request",
        "ADF 仅适用于 Cloud；Data Center 请提供 Markdown 或 wiki",
      );
    return input.value;
  }
  if (input.format === "wiki") {
    if (cloud)
      throw new ServiceError("invalid_request", "Cloud 请使用 Markdown 或 ADF");
    return input.text;
  }
  const tokens = marked.lexer(input.text, { gfm: true });
  return cloud
    ? { type: "doc", version: 1, content: blocks(tokens) }
    : wiki(tokens);
}
function unsupported(type: string): never {
  throw new ServiceError(
    "unsupported_content",
    `无法无损转换 Markdown ${type}；请使用原生 ADF/wiki。图片请先上传附件并使用对应原生引用。`,
  );
}
function inline(tokens: Json[], marks: Json[] = []): Json[] {
  return tokens.flatMap((t): Json[] => {
    switch (t.type) {
      case "strong":
        return inline(t.tokens, [...marks, { type: "strong" }]);
      case "em":
        return inline(t.tokens, [...marks, { type: "em" }]);
      case "del":
        return inline(t.tokens, [...marks, { type: "strike" }]);
      case "link": {
        if (!/^(https?:|mailto:|#)/i.test(t.href)) unsupported("link protocol");
        return inline(t.tokens, [
          ...marks,
          { type: "link", attrs: { href: t.href } },
        ]);
      }
      case "br":
        return [{ type: "hardBreak" }];
      case "codespan":
        return [
          { type: "text", text: t.text, marks: [...marks, { type: "code" }] },
        ];
      case "escape":
      case "text": {
        if (t.tokens) return inline(t.tokens, marks);
        // Explicit identities, resolved with search_users; no display-name guessing.
        return String(t.text)
          .split(/(@\{[^|{}]+\|[^{}]+\})/)
          .filter(Boolean)
          .map((part) => {
            const m = part.match(/^@\{([^|{}]+)\|([^{}]+)\}$/);
            return m
              ? { type: "mention", attrs: { id: m[1], text: "@" + m[2] } }
              : {
                  type: "text",
                  text: part,
                  ...(marks.length ? { marks } : {}),
                };
          });
      }
      default:
        return unsupported(t.type);
    }
  });
}
function listItem(item: Json): Json[] {
  const content = blocks(item.tokens);
  if (item.task) {
    if (content[0]?.type !== "paragraph")
      content.unshift({ type: "paragraph", content: [] });
    content[0].content.unshift({
      type: "text",
      text: item.checked ? "[x] " : "[ ] ",
    });
  }
  return content;
}
function blocks(tokens: Json[]): Json[] {
  return tokens.flatMap((t): Json[] => {
    switch (t.type) {
      case "space":
        return [];
      case "heading":
        return [
          {
            type: "heading",
            attrs: { level: t.depth },
            content: inline(t.tokens),
          },
        ];
      case "paragraph":
      case "text":
        return [
          {
            type: "paragraph",
            content: inline(t.tokens ?? [{ type: "text", text: t.text }]),
          },
        ];
      case "code":
        return [
          {
            type: "codeBlock",
            ...(t.lang ? { attrs: { language: t.lang } } : {}),
            ...(t.text ? { content: [{ type: "text", text: t.text }] } : {}),
          },
        ];
      case "blockquote":
        return [{ type: "blockquote", content: blocks(t.tokens) }];
      case "hr":
        return [{ type: "rule" }];
      case "list":
        return [
          {
            type: t.ordered ? "orderedList" : "bulletList",
            ...(t.ordered ? { attrs: { order: t.start } } : {}),
            content: t.items.map((i: Json) => ({
              type: "listItem",
              content: listItem(i),
            })),
          },
        ];
      case "table":
        return [
          {
            type: "table",
            attrs: { isNumberColumnEnabled: false, layout: "default" },
            content: [t.header, ...t.rows].map((row: Json[], n: number) => ({
              type: "tableRow",
              content: row.map((cell) => ({
                type: n === 0 ? "tableHeader" : "tableCell",
                attrs: {},
                content: [{ type: "paragraph", content: inline(cell.tokens) }],
              })),
            })),
          },
        ];
      default:
        return unsupported(t.type);
    }
  });
}
function wikiText(text: string) {
  return text
    .split(/(@\{[^|{}]+\|[^{}]+\})/)
    .map((part) => {
      const mention = part.match(/^@\{([^|{}]+)\|([^{}]+)\}$/);
      if (mention) return `[~${mention[1]}]`;
      return part.replace(/([{}\[\]*_!|])/g, "\\$1");
    })
    .join("");
}
function wiki(tokens: Json[], prefix = ""): string {
  return tokens
    .map((t) => {
      switch (t.type) {
        case "space":
          return "\n";
        case "heading":
          return `h${t.depth}. ` + wiki(t.tokens) + "\n\n";
        case "paragraph":
          return wiki(t.tokens) + "\n\n";
        case "text":
          return t.tokens ? wiki(t.tokens) : wikiText(String(t.text));
        case "escape":
          return "\\" + t.text;
        case "strong":
          return "*" + wiki(t.tokens) + "*";
        case "em":
          return "_" + wiki(t.tokens) + "_";
        case "del":
          return "-" + wiki(t.tokens) + "-";
        case "codespan":
          return "{{" + t.text + "}}";
        case "code":
          return `{code${t.lang ? ":" + t.lang : ""}}\n${t.text}\n{code}\n\n`;
        case "br":
          return "\\\\\n";
        case "hr":
          return "----\n";
        case "link":
          if (!/^(https?:|mailto:|#)/i.test(t.href))
            return unsupported("link protocol");
          return `[${wiki(t.tokens)}|${t.href}]`;
        case "blockquote":
          return `{quote}\n${wiki(t.tokens)}{quote}\n`;
        case "list": {
          const marker = prefix + (t.ordered ? "#" : "*");
          return (
            t.items
              .map((item: Json) => {
                const body = item.tokens
                  .map((token: Json) =>
                    token.type === "list"
                      ? "\n" + wiki([token], marker).trimEnd()
                      : wiki([token], marker).trimEnd(),
                  )
                  .join("");
                return `${marker} ${item.task ? (item.checked ? "[x] " : "[ ] ") : ""}${body}\n`;
              })
              .join("") + "\n"
          );
        }
        case "table":
          return (
            [t.header, ...t.rows]
              .map((row: Json[], n: number) => {
                const s = n ? "|" : "||";
                return s + row.map((c) => wiki(c.tokens)).join(s) + s;
              })
              .join("\n") + "\n"
          );
        default:
          return unsupported(t.type);
      }
    })
    .join("");
}
export function readable(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const n = value as Json;
  if (n.type === "text") return n.text ?? "";
  if (n.type === "mention") return n.attrs?.text ?? `@${n.attrs?.id}`;
  if (n.type === "hardBreak") return "\n";
  const children = Array.isArray(n.content)
    ? n.content.map(readable).join("")
    : "";
  return (
    children +
    (["paragraph", "heading", "listItem", "tableRow", "codeBlock"].includes(
      n.type,
    )
      ? "\n"
      : "")
  );
}
