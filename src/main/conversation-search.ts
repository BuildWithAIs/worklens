import type { Nodes } from "mdast";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type {
  ConversationSearchSnippet,
  MessageView,
} from "../shared/contracts";
import { foldSearchText } from "../shared/search-text";

// The renderer's Markdown syntax, so replies are searched as they are read.
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
const lines = new Set(["root", "blockquote", "list", "listItem", "table"]);

function plainText(node: Nodes): string {
  if (node.type === "image") return node.alt ?? "";
  if (node.type === "break") return "\n";
  if (node.type === "definition") return "";
  if ("value" in node) return node.value;
  if (!("children" in node)) return "";
  const separator = lines.has(node.type)
    ? "\n"
    : node.type === "tableRow"
      ? " "
      : "";
  return node.children.map(plainText).join(separator);
}

/** The text a reader sees in rendered Markdown, with blocks on their own lines. */
export function markdownText(markdown: string) {
  return plainText(parser.parse(markdown));
}

export interface SearchableMessage {
  text: string;
  folded: string;
  /** The user message that starts this turn; the thread renders it by this ID. */
  turnId?: string;
}

// Only visible prompt and reply text is searched; thinking and tool output are
// not. Replies come first, as ChatGPT does: titles usually repeat the first
// prompt, so a reply makes the more informative snippet.
export function searchableMessages(
  messages: readonly MessageView[],
): SearchableMessage[] {
  const replies: SearchableMessage[] = [];
  const prompts: SearchableMessage[] = [];
  let turnId: string | undefined;
  for (const message of messages) {
    if (message.role === "user") turnId = message.entryId;
    if (message.role !== "user" && message.role !== "assistant") continue;
    // Prompts are shown as typed; replies are rendered Markdown.
    const text =
      message.role === "user" ? message.text : markdownText(message.text);
    if (text.trim())
      (message.role === "user" ? prompts : replies).push({
        text,
        folded: foldSearchText(text),
        turnId,
      });
  }
  return [...replies, ...prompts];
}

/**
 * Whether stored Markdown may contain the needle once rendered. Markup can
 * split a phrase, so only require each of its characters; rendered text never
 * has characters its source lacks.
 */
export function mayContain(foldedSource: string, needle: string) {
  return [...new Set(needle.replace(/\s/g, ""))].every((character) =>
    foldedSource.includes(character),
  );
}

const collapse = (text: string) => text.replace(/\s+/g, " ");

export function searchSnippet(
  text: string,
  index: number,
  length: number,
  context = { before: 40, after: 120 },
): ConversationSearchSnippet {
  const start = Math.max(0, index - context.before);
  const end = Math.min(text.length, index + length + context.after);
  const before = collapse(text.slice(start, index)).trimStart();
  const after = collapse(text.slice(index + length, end)).trimEnd();
  return {
    before: start > 0 && before ? `…${before}` : before,
    match: collapse(text.slice(index, index + length)),
    after: end < text.length && after ? `${after}…` : after,
  };
}
