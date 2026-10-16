import { foldSearchText } from "../../../shared/search-text";

const HIGHLIGHT = "worklens-search";
const skipped = "button, [aria-hidden='true'], .sr-only";

export function clearSearchHighlight() {
  CSS.highlights?.delete(HIGHLIGHT);
}

// Rendered Markdown splits text across elements, so match across the text
// nodes of one message and map the offsets back to a DOM range.
export function findRenderedMatch(message: Element, query: string) {
  const needle = foldSearchText(query.trim());
  if (!needle) return undefined;
  const nodes: { node: Text; start: number }[] = [];
  let text = "";
  const walker = document.createTreeWalker(message, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || parent.closest(skipped) || !parent.checkVisibility())
      continue;
    nodes.push({ node: node as Text, start: text.length });
    text += (node as Text).data;
  }
  const index = foldSearchText(text).indexOf(needle);
  if (index < 0) return undefined;
  const locate = (offset: number, end: boolean) => {
    const found = nodes.findLast(({ node, start }) =>
      end ? start < offset : start <= offset && offset < start + node.length,
    )!;
    return [found.node, offset - found.start] as const;
  };
  const range = document.createRange();
  range.setStart(...locate(index, false));
  range.setEnd(...locate(index + needle.length, true));
  return range;
}

/**
 * Scrolls the first visible rendered match into view and highlights it. When
 * the match is collapsed (a long prompt or a process disclosure), scrolls to
 * the turn's prompt instead.
 */
export function revealSearchMatch(
  thread: Element,
  query: string,
  messageId?: string,
) {
  clearSearchHighlight();
  let range: Range | undefined;
  // Replies first, matching the snippet chosen by the search.
  const messages = [
    ...thread.querySelectorAll('[data-role="assistant"]'),
    ...thread.querySelectorAll('[data-role="user"]'),
  ];
  for (const message of messages) {
    range = findRenderedMatch(message, query);
    if (range) break;
  }
  const target =
    range?.startContainer.parentElement ??
    (messageId
      ? thread.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`)
      : null);
  if (!target) return false;
  if (range && typeof Highlight === "function")
    CSS.highlights?.set(HIGHLIGHT, new Highlight(range));
  const block = range ? "center" : "start";
  target.scrollIntoView({ block, behavior: "instant" });
  // Messages above may still have estimated heights (content-visibility);
  // scroll again once they have been laid out.
  requestAnimationFrame(() =>
    requestAnimationFrame(() =>
      target.scrollIntoView({ block, behavior: "instant" }),
    ),
  );
  return true;
}
