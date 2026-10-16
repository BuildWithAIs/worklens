import type { Nodes } from "mdast";
import type {
  ConversationSearchSnippet,
  MessageView,
} from "../shared/contracts";
import { foldSearchText } from "../shared/search-text";

let parser: { parse(markdown: string): Nodes } | undefined;
let loading: Promise<void> | undefined;

/**
 * Loads the renderer's Markdown syntax, so replies are searched as they are
 * read. Loaded on the first search rather than at startup.
 */
export function loadMarkdownParser() {
  loading ??= Promise.all([
    import("unified"),
    import("remark-parse"),
    import("remark-gfm"),
    import("remark-math"),
  ]).then(
    ([{ unified }, remarkParse, remarkGfm, remarkMath]) => {
      parser = unified()
        .use(remarkParse.default)
        .use(remarkGfm.default)
        .use(remarkMath.default);
    },
    (error) => {
      loading = undefined;
      throw error;
    },
  );
  return loading;
}

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
  if (!parser) throw new Error("Call loadMarkdownParser() first");
  return plainText(parser.parse(markdown));
}

export interface SearchableMessage {
  text: string;
  folded: string;
  /** The user message that starts this turn; the thread renders it by this ID. */
  turnId?: string;
}

/** Awaited between pieces of work: yields to other work and stops when cancelled. */
export type Checkpoint = () => Promise<void>;

// Only visible prompt and reply text is searched; thinking and tool output are
// not. Replies come first, as ChatGPT does: titles usually repeat the first
// prompt, so a reply makes the more informative snippet.
export async function searchableMessages(
  messages: readonly MessageView[],
  checkpoint: Checkpoint = async () => {},
  /** Plain text of replies parsed before, by their Markdown; kept current. */
  parsed: Map<string, string> = new Map(),
): Promise<SearchableMessage[]> {
  const replies: SearchableMessage[] = [];
  const prompts: SearchableMessage[] = [];
  const used = new Set<string>();
  let turnId: string | undefined;
  for (const message of messages) {
    if (message.role === "user") turnId = message.entryId;
    if (message.role !== "user" && message.role !== "assistant") continue;
    // Prompts are shown as typed; replies are rendered Markdown.
    let text = message.text;
    if (message.role === "assistant") {
      used.add(message.text);
      const known = parsed.get(message.text);
      if (known === undefined) {
        // Stored at once, so work before a cancellation is kept.
        text = markdownText(message.text);
        parsed.set(message.text, text);
        await checkpoint();
      } else text = known;
    }
    if (text.trim())
      (message.role === "user" ? prompts : replies).push({
        text,
        folded: foldSearchText(text),
        turnId,
      });
  }
  for (const markdown of parsed.keys())
    if (!used.has(markdown)) parsed.delete(markdown);
  return [...replies, ...prompts];
}

const reference =
  /&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/g;

/**
 * Stored Markdown for the prefilter, followed by what its character
 * references render as: `&euro;` shows as €, a character the source lacks.
 */
export function prefilterSource(markdown: string) {
  const references = new Set(markdown.match(reference));
  if (!references.size) return markdown;
  return [markdown, ...[...references].map(markdownText)].join("\n");
}

/**
 * Whether stored Markdown may contain the needle once rendered. Markup can
 * split a phrase, so only require each of its characters; rendered text has
 * no characters missing from its `prefilterSource`.
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
