import {
  escapeCurrencyDollars,
  normalizeMathDelimiters,
} from "@assistant-ui/react-markdown";
import type { RootContent } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";

const parser = unified().use(remarkParse);

/** Transform presentation only; keep code, including unfinished fences, verbatim. */
export function preprocessMarkdownMath(text: string): string {
  if (!/[$\\]|\[\/(?:math|inline)\]/.test(text)) return text;

  const protectedRanges: { start: number; end: number }[] = [];
  function walk(nodes: RootContent[]) {
    for (const node of nodes) {
      if (node.type === "code" || node.type === "inlineCode") {
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        if (start !== undefined && end !== undefined)
          protectedRanges.push({ start, end });
      } else if ("children" in node) walk(node.children);
    }
  }
  walk(parser.parse(text).children);

  const transform = (value: string) => {
    // Display fences need their own lines and must not continue a prose paragraph.
    const displayMath = value
      .replace(/\\{1,2}\[([\s\S]+?)\\{1,2}\]/g, (match, body: string) =>
        body.trim() ? `\n\n$$\n${body.trim()}\n$$\n\n` : match,
      )
      .replace(
        /^[ \t]*\$\$([^\n]+?)\$\$[ \t]*$/gm,
        (_, body: string) => `$$\n${body}\n$$`,
      );
    return escapeCurrencyDollars(normalizeMathDelimiters(displayMath));
  };
  let result = "";
  let cursor = 0;
  for (const { start, end } of protectedRanges) {
    result += transform(text.slice(cursor, start)) + text.slice(start, end);
    cursor = end;
  }
  return result + transform(text.slice(cursor));
}
