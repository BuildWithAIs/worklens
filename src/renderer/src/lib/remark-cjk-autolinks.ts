import type { Link, Parent, Root, Text } from "mdast";

/** GFM literal URLs do not treat CJK sentence punctuation as a boundary. */
export function remarkCjkAutolinks() {
  return (tree: Root, file: { value: unknown }) => {
    const source = String(file.value);
    function walk(parent: Parent) {
      for (let index = 0; index < parent.children.length; index++) {
        const child = parent.children[index];
        if (child.type === "link" && child.children.length === 1) {
          const start = child.position?.start.offset;
          const end = child.position?.end.offset;
          const label = child.children[0];
          // Explicit [label](url) and <url> syntax must retain the author's intent.
          if (
            start !== undefined &&
            end !== undefined &&
            /^https?:\/\//i.test(source.slice(start, end)) &&
            label.type === "text"
          ) {
            const boundary = label.value.search(/[，。！？；、（）【】“”‘’]/u);
            if (boundary > 0) {
              const url = label.value.slice(0, boundary);
              try {
                if (!new URL(url).hostname) continue;
              } catch {
                continue;
              }
              const link: Link = {
                type: "link",
                url,
                children: [{ type: "text", value: url }],
              };
              const suffix: Text = {
                type: "text",
                value: label.value.slice(boundary),
              };
              parent.children.splice(index, 1, link, suffix);
              index++;
              continue;
            }
          }
        }
        if ("children" in child) walk(child);
      }
    }
    walk(tree);
  };
}
