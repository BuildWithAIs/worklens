import { foldSearchText } from "../../../shared/search-text";

const HIGHLIGHT = "worklens-search";
// Controls and labels a message shows beside its text, such as a code
// block's language. A control that shows the message's own text, such as a
// skill call's tag, is marked searchable.
const skipped =
  "button:not([data-searchable]), [aria-hidden='true'], .sr-only, .aui-code-header-root";
const blocks = "p, li, h1, h2, h3, h4, h5, h6, pre, blockquote, td, th, dt, dd";
const cell = "td, th";

const modifiers = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock"]);
let stopDismissing: (() => void) | undefined;

export function clearSearchHighlight() {
  CSS.highlights?.delete(HIGHLIGHT);
  document
    .querySelectorAll("[data-search-match]")
    .forEach((element) => element.removeAttribute("data-search-match"));
  stopDismissing?.();
  stopDismissing = undefined;
}

// The highlight shows where a search jumped. The next key press or click
// anywhere means the reader moved on; scrolling doesn't, since they may read
// around the match. Attached after the jump, so the Enter or click that
// opened the result can't clear it.
function dismissOnNextAction() {
  const dismiss = (event: Event) => {
    if (event instanceof KeyboardEvent && modifiers.has(event.key)) return;
    clearSearchHighlight();
  };
  window.addEventListener("keydown", dismiss, true);
  window.addEventListener("pointerdown", dismiss, true);
  stopDismissing = () => {
    window.removeEventListener("keydown", dismiss, true);
    window.removeEventListener("pointerdown", dismiss, true);
  };
}

// Rendered Markdown splits text across elements, so match across the text
// nodes of one message and map the offsets back to DOM ranges.
export function findRenderedMatches(message: Element, query: string) {
  const needle = foldSearchText(query.trim());
  if (!needle) return [];
  const nodes: (
    | { node: Text; start: number; length: number }
    | { formula: Element; start: number; length: number }
  )[] = [];
  const formulas = new Set<Element>();
  let text = "";
  let previous: Element | null | undefined;
  const walker = document.createTreeWalker(message, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent) continue;
    const formula = parent.closest(".katex");
    const visible = formula ?? parent;
    if (visible.closest(skipped) || !visible.checkVisibility()) continue;
    if (formula && formulas.has(formula)) continue;
    // Break between blocks as the search's plain text does: a space between
    // cells of a row, a line break otherwise.
    const block = visible.closest(blocks);
    if (previous !== undefined && block !== previous)
      text +=
        block?.matches(cell) &&
        previous?.matches(cell) &&
        block.parentElement === previous.parentElement
          ? " "
          : "\n";
    previous = block;
    if (formula) {
      const source = formula.querySelector(
        'annotation[encoding="application/x-tex"]',
      )?.textContent;
      formulas.add(formula);
      if (!source) continue;
      nodes.push({ formula, start: text.length, length: source.length });
      text += source;
    } else {
      nodes.push({
        node: node as Text,
        start: text.length,
        length: (node as Text).length,
      });
      text += (node as Text).data;
    }
  }
  const locate = (offset: number, end: boolean): [Node, number] => {
    const found = nodes.findLast(({ length, start }) =>
      end ? start < offset : start <= offset && offset < start + length,
    )!;
    // Any match within LaTeX maps to the entire rendered formula.
    if ("formula" in found) {
      const parent = found.formula.parentNode!;
      const index = [...parent.childNodes].indexOf(found.formula);
      return [parent, index + (end ? 1 : 0)];
    }
    return [found.node, offset - found.start];
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
// collapsed prompt, is not visible. A match is judged by where it starts: it
// may run on out of a box that clips, such as a skill call's tag.
function clipped(range: Range, boundary: Element) {
  const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
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
 * Scrolls the first visible rendered match in the snippet's turn into view
 * and highlights it. When the match there is collapsed (a long prompt or a
 * process disclosure), scrolls to the turn's prompt instead.
 */
export function revealSearchMatch(
  thread: Element,
  query: string,
  messageId?: string,
) {
  clearSearchHighlight();
  const prompt = messageId
    ? thread.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`)
    : null;
  // Only the snippet's turn: its prompt and the replies before the next one.
  // A later turn with the same words is a different match.
  let turn = [...thread.querySelectorAll("[data-role]")];
  const start = prompt ? turn.indexOf(prompt) : -1;
  if (start >= 0) {
    const end = turn.findIndex(
      (message, index) =>
        index > start && message.getAttribute("data-role") === "user",
    );
    turn = turn.slice(start, end < 0 ? undefined : end);
  }
  // Replies first, matching the snippet chosen by the search. Only the text
  // the search indexes: not thinking, tools, summaries or message controls.
  const role = (name: string) =>
    turn.filter((message) => message.getAttribute("data-role") === name);
  const texts = [...role("assistant"), ...role("user")].flatMap((message) => [
    ...message.querySelectorAll("[data-search-text]"),
  ]);
  let range: Range | undefined;
  let control: Element | undefined;
  for (const text of texts) {
    for (const candidate of findRenderedMatches(text, query)) {
      if (!clipped(candidate, thread)) {
        range = candidate;
        break;
      }
      // A match cut off inside a searchable control, such as a skill name its
      // tag shortens, reveals the whole control while the control shows.
      const owner = [candidate.startContainer, candidate.endContainer]
        .map((node) => node.parentElement?.closest("[data-searchable]"))
        .find((element) => element && text.contains(element));
      if (!owner) continue;
      const whole = document.createRange();
      whole.selectNodeContents(owner);
      if (clipped(whole, thread)) continue;
      range = whole;
      control = owner;
      break;
    }
    if (range) break;
  }
  const view = scroller(thread);
  if (!(range ?? prompt) || !view) return false;
  if (range && typeof Highlight === "function") {
    CSS.highlights?.set(HIGHLIGHT, new Highlight(range));
    for (const formula of thread.querySelectorAll(".katex"))
      if (range.intersectsNode(formula))
        formula.setAttribute("data-search-match", "");
    control?.setAttribute("data-search-match", "");
    dismissOnNextAction();
  }
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
