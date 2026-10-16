import type {
  ConversationSearchSnippet,
  MessageView,
} from "../shared/contracts";
import { foldSearchText } from "../shared/search-text";
import {
  searchParser,
  type IndexedSearchText,
  type SearchTextKind,
} from "./search-parser";

let parser: typeof import("./search-markdown") | undefined;
let loading: Promise<void> | undefined;

/**
 * Loads the renderer's Markdown syntax, so replies are searched as they are
 * read. Loaded on the first search rather than at startup.
 */
export function loadMarkdownParser() {
  loading ??= import("./search-markdown").then(
    (module) => {
      parser = module;
    },
    (error) => {
      loading = undefined;
      throw error;
    },
  );
  return loading;
}

/** The text a reader sees in rendered Markdown, with blocks on their own lines. */
export function markdownText(markdown: string) {
  if (!parser) throw new Error("Call loadMarkdownParser() first");
  return parser.parseSearchMarkdown(markdown);
}

// Above this size, parsing and case folding run away from the Electron main thread.
const WORKER_THRESHOLD = 8 * 1024;
export async function indexSearchText(
  text: string,
  kind: SearchTextKind,
  checkpoint: Checkpoint,
): Promise<IndexedSearchText> {
  if (text.length > WORKER_THRESHOLD) {
    const result = await searchParser.read(text, kind, checkpoint);
    await checkpoint();
    return result;
  }
  if (kind === "source") {
    if (!parser) throw new Error("Call loadMarkdownParser() first");
    return { text: "", folded: parser.searchSourceCharacters(text) };
  }
  const value = kind === "markdown" ? markdownText(text) : text;
  return { text: value, folded: foldSearchText(value) };
}

export interface SearchableMessage {
  text: string;
  folded: string;
  /** The user message that starts this turn; the thread renders it by this ID. */
  turnId?: string;
}

/**
 * Awaited after each piece of work: throws when cancelled, and returns a
 * promise only when the time budget is spent and it yields to other work.
 */
export type Checkpoint = () => Promise<void> | undefined;

// Only visible prompt and reply text is searched; thinking and tool output are
// not. Replies come first, as ChatGPT does: titles usually repeat the first
// prompt, so a reply makes the more informative snippet.
export async function searchableMessages(
  messages: readonly MessageView[],
  checkpoint: Checkpoint = () => undefined,
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
    let folded: string | undefined;
    if (message.role === "assistant") {
      used.add(message.text);
      const known = parsed.get(message.text);
      if (known === undefined) {
        // Stored at once, so work before a cancellation is kept.
        const indexed = await indexSearchText(
          message.text,
          "markdown",
          checkpoint,
        );
        text = indexed.text;
        folded = indexed.folded;
        parsed.set(message.text, text);
      } else {
        text = known;
        // Preserve encounter order when a bounded cache keeps only recent replies.
        parsed.delete(message.text);
        parsed.set(message.text, known);
      }
    }
    if (text.trim())
      (message.role === "user" ? prompts : replies).push({
        text,
        folded:
          folded ?? (await indexSearchText(text, "text", checkpoint)).folded,
        turnId,
      });
    // After every message, parsed or cached: folding long text takes time too.
    await checkpoint();
  }
  for (const markdown of parsed.keys())
    if (!used.has(markdown)) parsed.delete(markdown);
  return [...replies, ...prompts];
}

/**
 * Stored Markdown for the prefilter, followed by what its character
 * references render as: `&euro;` shows as €, a character the source lacks.
 */
export function prefilterSource(markdown: string) {
  if (!parser) throw new Error("Call loadMarkdownParser() first");
  return parser.searchPrefilterSource(markdown);
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
