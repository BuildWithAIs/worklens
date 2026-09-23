import type { Link, Parent, Root } from "mdast";
import { fileName } from "./link-label";
import {
  isLocalReference,
  localPathSpans,
} from "../../../shared/file-references";

function fileLink(path: string, label?: string): Link {
  return {
    type: "link",
    url: path,
    children: [{ type: "text", value: label || path }],
    data: {
      hProperties: {
        "data-local-path": path,
        ...(label ? { "data-local-label": label } : {}),
      },
    },
  };
}

export function remarkLocalFiles({
  enabled = true,
  producedPaths = new Set<string>(),
  availablePaths = producedPaths,
}: {
  enabled?: boolean;
  producedPaths?: ReadonlySet<string>;
  availablePaths?: ReadonlySet<string>;
} = {}) {
  return (tree: Root) => {
    if (!enabled) return;
    const actionable = (path: string) =>
      isLocalReference(path) && availablePaths.has(path);
    function walk(parent: Parent) {
      for (let index = 0; index < parent.children.length; index++) {
        const child = parent.children[index];
        if (child.type === "link" || child.type === "image") {
          let path = child.url;
          try {
            path = decodeURIComponent(path);
          } catch {
            /* literal path */
          }
          if (isLocalReference(path)) {
            if (!availablePaths.has(path)) {
              // A suggested or unavailable file is ordinary content, not an
              // actionable deliverable. Preserve inline formatting and labels.
              const fallback =
                child.type === "link"
                  ? child.children
                  : [{ type: "text" as const, value: child.alt || path }];
              parent.children.splice(index, 1, ...fallback);
              index += fallback.length - 1;
              continue;
            }
            const labelText = (node: {
              value?: string;
              children?: unknown[];
            }): string =>
              node.value ??
              node.children
                ?.map((child) => labelText(child as typeof node))
                .join("") ??
              "";
            const label = child.type === "image" ? child.alt : labelText(child);
            parent.children[index] = fileLink(
              path,
              label &&
                label !== path &&
                label !== child.url &&
                label !== fileName(path)
                ? label
                : undefined,
            );
          }
          continue;
        }
        if (child.type === "inlineCode" && actionable(child.value.trim())) {
          parent.children[index] = fileLink(child.value.trim());
          continue;
        }
        if (child.type === "text") {
          const spans = localPathSpans(child.value, [...availablePaths]).filter(
            (span) => actionable(span.value),
          );
          if (!spans.length) continue;
          const nodes: (Link | { type: "text"; value: string })[] = [];
          let offset = 0;
          for (const span of spans) {
            nodes.push(
              { type: "text", value: child.value.slice(offset, span.start) },
              fileLink(span.value),
            );
            offset = span.start + span.value.length;
          }
          nodes.push({ type: "text", value: child.value.slice(offset) });
          parent.children.splice(index, 1, ...nodes);
          index += nodes.length - 1;
        } else if ("children" in child) walk(child);
      }
    }
    walk(tree);
    // Preserve author labels; add only enough directory context to distinguish
    // otherwise identical filenames in this message.
    const links: Link[] = [];
    function collect(parent: Parent) {
      for (const child of parent.children) {
        if (
          child.type === "link" &&
          child.data?.hProperties?.["data-local-path"]
        )
          links.push(child);
        else if ("children" in child) collect(child);
      }
    }
    collect(tree);
    for (const link of links) {
      if (link.data!.hProperties!["data-local-label"]) continue;
      const paths = [
        ...new Set(
          links
            .filter((item) => fileName(item.url) === fileName(link.url))
            .map((item) => item.url),
        ),
      ];
      if (paths.length < 2) continue;
      const parts = link.url.split(/[\\/]/).filter(Boolean);
      let depth = 2;
      while (
        depth < parts.length &&
        paths.some(
          (path) =>
            path !== link.url &&
            path.split(/[\\/]/).filter(Boolean).slice(-depth).join("/") ===
              parts.slice(-depth).join("/"),
        )
      )
        depth++;
      link.data!.hProperties!["data-local-label"] = parts
        .slice(-depth)
        .join("/");
    }

    // Keep all inline references in place. HTML cards are independent blocks;
    // a lone HTML link can itself be a card, otherwise append it after the text.
    const cards = new Map<string, Link>();
    for (const link of links) {
      if (producedPaths.has(link.url) && /\.html?$/i.test(link.url))
        cards.set(link.url, link);
    }
    for (const child of tree.children) {
      if (child.type !== "paragraph") continue;
      const content = child.children.filter(
        (node) => node.type !== "text" || node.value.trim(),
      );
      if (
        content.length === 1 &&
        content[0].type === "link" &&
        cards.has(content[0].url)
      ) {
        content[0].data!.hProperties!["data-local-display"] = "card";
        cards.delete(content[0].url);
      }
    }
    for (const link of cards.values()) {
      tree.children.push({
        type: "paragraph",
        children: [
          {
            ...link,
            data: {
              ...link.data,
              hProperties: {
                ...link.data?.hProperties,
                "data-local-display": "card",
              },
            },
          },
        ],
      });
    }
  };
}
