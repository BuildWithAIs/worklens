import type { Nodes } from "mdast";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { preprocessMarkdownMath } from "../shared/markdown-math";
import { remarkCjkAutolinks } from "../shared/remark-cjk-autolinks";
import { foldSearchText } from "../shared/search-text";

const parser = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkCjkAutolinks);
const lines = new Set(["root", "blockquote", "list", "listItem", "table"]);

function plainText(node: Nodes): string {
  if (node.type === "image") return node.alt ?? "";
  if (node.type === "break") return "\n";
  if (node.type === "definition") return "";
  // Code and formulas retain their literal source; prose follows rendering.
  if ("value" in node) return node.value;
  if (!("children" in node)) return "";
  const separator = lines.has(node.type)
    ? "\n"
    : node.type === "tableRow"
      ? " "
      : "";
  return node.children.map(plainText).join(separator);
}

export function parseSearchMarkdown(markdown: string) {
  const value = preprocessMarkdownMath(markdown);
  return plainText(parser.runSync(parser.parse(value), { value }) as Nodes);
}

const reference =
  /&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/g;

export function searchPrefilterSource(markdown: string) {
  const references = new Set(markdown.match(reference));
  if (!references.size) return markdown;
  return [markdown, ...[...references].map(parseSearchMarkdown)].join("\n");
}

// mayContain only needs character membership, not a duplicate of the source.
export function searchSourceCharacters(markdown: string) {
  return [...new Set(foldSearchText(searchPrefilterSource(markdown)))].join("");
}
