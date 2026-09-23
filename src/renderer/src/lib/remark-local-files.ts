import type { Link, List, Paragraph, Parent, Root, RootContent } from "mdast";
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

export function remarkLocalFiles({ enabled = true } = {}) {
  return (tree: Root) => {
    if (!enabled) return;
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
                !isLocalReference(label)
                ? label
                : undefined,
            );
          }
          continue;
        }
        if (
          child.type === "inlineCode" &&
          isLocalReference(child.value.trim())
        ) {
          parent.children[index] = fileLink(child.value.trim());
          continue;
        }
        if (child.type === "text") {
          const spans = localPathSpans(child.value);
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

    const artifactParagraphs = (
      paragraph: Paragraph,
    ): Paragraph[] | undefined => {
      const children = [...paragraph.children];
      while (children[0]?.type === "text" && !children[0].value.trim())
        children.shift();
      const first = children[0];
      if (
        first?.type !== "link" ||
        !first.data?.hProperties?.["data-local-path"] ||
        !/\.html?$/i.test(first.url)
      )
        return;
      const rest = children.slice(1);
      if (rest[0]?.type === "text")
        rest[0] = {
          ...rest[0],
          value: rest[0].value.replace(/^\s*[:：–—-]?\s*/, ""),
        };
      const description = rest;
      while (description[0]?.type === "text" && !description[0].value.trim())
        description.shift();
      return [
        { type: "paragraph", children: [first] },
        ...(description.length
          ? [{ type: "paragraph" as const, children: description }]
          : []),
      ];
    };
    // HTML deliverables are block content. Split simple unordered file lists
    // around them, retaining the original order and accompanying description.
    function layout(parent: Root | import("mdast").Blockquote) {
      const output: RootContent[] = [];
      for (const child of parent.children) {
        if (child.type === "blockquote") layout(child);
        if (child.type !== "list" || child.ordered) {
          output.push(
            ...(child.type === "paragraph"
              ? (artifactParagraphs(child) ?? [child])
              : [child]),
          );
          continue;
        }
        let items: List["children"] = [];
        const flush = () => {
          if (items.length) output.push({ ...child, children: items });
          items = [];
        };
        for (const item of child.children) {
          const blocks =
            item.children.length === 1 &&
            item.children[0].type === "paragraph" &&
            item.checked == null
              ? artifactParagraphs(item.children[0])
              : undefined;
          if (!blocks) items.push(item);
          else {
            flush();
            output.push(...blocks);
          }
        }
        flush();
      }
      parent.children = output as typeof parent.children;
    }
    layout(tree);
    // Keep a single file's trailing description before its actions. Do not
    // combine multiple links, which would make the action target ambiguous.
    function groupDescriptions(parent: Parent) {
      for (const child of parent.children) {
        if (child.type === "paragraph") {
          const nodes = [...child.children];
          while (nodes[0]?.type === "text" && !nodes[0].value.trim())
            nodes.shift();
          const first = nodes[0];
          const hasLink = (node: (typeof nodes)[number]): boolean =>
            node.type === "link" ||
            node.type === "linkReference" ||
            ("children" in node && node.children.some(hasLink));
          if (
            first?.type === "link" &&
            first.data?.hProperties?.["data-local-path"] &&
            !/\.html?$/i.test(first.url) &&
            nodes.length > 1 &&
            !nodes.slice(1).some(hasLink)
          ) {
            first.data.hProperties["data-local-description"] = "true";
            first.children = nodes.slice(1) as Link["children"];
            child.children = [first];
          }
        } else if ("children" in child) groupDescriptions(child);
      }
    }
    groupDescriptions(tree);
  };
}
