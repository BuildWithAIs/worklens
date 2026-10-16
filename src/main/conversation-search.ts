import type {
  ConversationSearchSnippet,
  MessageView,
} from "../shared/contracts";
import { foldSearchText } from "../shared/search-text";

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
    if (
      (message.role === "user" || message.role === "assistant") &&
      message.text.trim()
    )
      (message.role === "user" ? prompts : replies).push({
        text: message.text,
        folded: foldSearchText(message.text),
        turnId,
      });
  }
  return [...replies, ...prompts];
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
