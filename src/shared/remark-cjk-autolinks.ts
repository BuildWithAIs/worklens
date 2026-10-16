import type { Parent, Root } from "mdast";
import type { Processor } from "unified";

const startsWithUrl = /^(?:https?:\/\/|www\.)/i;
const cjkBoundary = /[，。！？；、（）【】“”‘’]/u;

/** GFM literal URLs do not treat CJK sentence punctuation as a boundary. */
export function remarkCjkAutolinks(this: Processor) {
  const processor = this;
  return (tree: Root, file: { value: unknown }) => {
    let source = String(file.value);
    let parsed = tree;
    // Reparse only when a literal URL swallowed prose. Making that URL explicit
    // lets the existing parser recover code/emphasis, including spans with spaces.
    // This changes only the render tree, never the stored message or file.value.
    while (true) {
      const edits: { start: number; end: number; markdown: string }[] = [];
      function walk(parent: Parent) {
        for (const child of parent.children) {
          if (child.type === "link") {
            const start = child.position?.start.offset;
            const end = child.position?.end.offset;
            const label = child.children[0];
            // Explicit links and angle autolinks retain the author's intent.
            if (
              start !== undefined &&
              end !== undefined &&
              child.children.length === 1 &&
              label.type === "text"
            ) {
              const raw = source.slice(start, end);
              const boundary = raw.search(cjkBoundary);
              if (!startsWithUrl.test(raw) || boundary <= 0) continue;
              const text = raw.slice(0, boundary);
              const url = /^www\./i.test(text) ? `http://${text}` : text;
              try {
                if (!new URL(url).hostname) continue;
              } catch {
                continue;
              }
              const escapedLabel = text.replace(/[\\`*_[\]<>~&]/g, "\\$&");
              const destination = url
                .replace(/[\\<>]/g, "\\$&")
                .replace(/&/g, "&amp;");
              edits.push({
                start,
                end: start + boundary,
                markdown: `[${escapedLabel}](<${destination}>)`,
              });
            }
          } else if ("children" in child) walk(child);
        }
      }
      walk(parsed);
      if (!edits.length) break;
      for (const edit of edits.sort((a, b) => b.start - a.start)) {
        source =
          source.slice(0, edit.start) + edit.markdown + source.slice(edit.end);
      }
      parsed = processor.parse(source) as Root;
    }
    tree.children = parsed.children;
  };
}
