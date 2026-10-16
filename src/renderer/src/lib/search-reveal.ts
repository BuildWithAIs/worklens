import { foldSearchText } from "../../../shared/search-text";

const HIGHLIGHT = "worklens-search";
const skipped = "button, [aria-hidden='true'], .sr-only";

export function clearSearchHighlight() {
  CSS.highlights?.delete(HIGHLIGHT);
}

// Rendered Markdown splits text across elements, so match across the text
// nodes of one message and map the offsets back to DOM ranges.
export function findRenderedMatches(message: Element, query: string) {
  const needle = foldSearchText(query.trim());
  if (!needle) return [];
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
  const locate = (offset: number, end: boolean) => {
    const found = nodes.findLast(({ node, start }) =>
      end ? start < offset : start <= offset && offset < start + node.length,
    )!;
    return [found.node, offset - found.start] as const;
  };
  const folded = foldSearchText(text);
  const ranges: Range[] = [];
  for (
    let index = folded.indexOf(needle);
    index >= 0;
    index = folded.indexOf(needle, index + needle.length)
  ) {
    const range = document.createRange();
    range.setStart(...locate(index, false));
    range.setEnd(...locate(index + needle.length, true));
    ranges.push(range);
  }
  return ranges;
}

// Text past the edge of a box that clips without scrolling, such as a
// collapsed prompt, is not visible.
function clipped(range: Range, boundary: Element) {
  const rect = range.getBoundingClientRect();
  for (
    let element = range.startContainer.parentElement;
    element && element !== boundary;
    element = element.parentElement
  ) {
    const { overflowX, overflowY } = getComputedStyle(element);
    if (!/hidden|clip/.test(`${overflowX} ${overflowY}`)) continue;
    const box = element.getBoundingClientRect();
    if (
      rect.top < box.top ||
      rect.bottom > box.bottom ||
      rect.left < box.left ||
      rect.right > box.right
    )
      return true;
  }
  return false;
}

function scroller(element: Element) {
  for (
    let parent = element.parentElement;
    parent;
    parent = parent.parentElement
  )
    if (/auto|scroll/.test(getComputedStyle(parent).overflowY)) return parent;
  return document.scrollingElement;
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
  // Replies first, matching the snippet chosen by the search.
  const messages = [
    ...thread.querySelectorAll('[data-role="assistant"]'),
    ...thread.querySelectorAll('[data-role="user"]'),
  ];
  let range: Range | undefined;
  for (const message of messages) {
    range = findRenderedMatches(message, query).find(
      (candidate) => !clipped(candidate, thread),
    );
    if (range) break;
  }
  const prompt = messageId
    ? thread.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`)
    : null;
  const view = scroller(thread);
  if (!(range ?? prompt) || !view) return false;
  if (range && typeof Highlight === "function")
    CSS.highlights?.set(HIGHLIGHT, new Highlight(range));
  const place = () => {
    if (!range) {
      prompt?.scrollIntoView({ block: "start", behavior: "instant" });
      return;
    }
    // Center the match itself: in a long paragraph it can be far from the
    // paragraph's center. Leave room for the composer below.
    const box = view.getBoundingClientRect();
    const match = range.getBoundingClientRect();
    view.scrollBy({
      top: match.top + match.height / 2 - (box.top + box.height * 0.4),
      behavior: "instant",
    });
  };
  place();
  // Messages above may still have estimated heights (content-visibility);
  // scroll again once they have been laid out.
  requestAnimationFrame(() => requestAnimationFrame(place));
  return true;
}
