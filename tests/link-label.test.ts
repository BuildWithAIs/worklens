import { expect, test } from "vitest";
import { fileName, shortUrl } from "../src/renderer/src/lib/link-label";
import { isLocalReference } from "../src/shared/file-references";
import { remarkLocalFiles } from "../src/renderer/src/lib/remark-local-files";
import type { Root } from "mdast";

test("display shortening keeps filenames and domains without altering targets", () => {
  const url =
    "https://example.com/" + "long/".repeat(20) + "report.html?token=123";
  expect(shortUrl(url)).toBe("example.com/…/report.html?…");
  expect(shortUrl("https://example.com")).toBe("https://example.com");
});

test("file links retain meaningful author labels and the original full target", () => {
  const path = "/Users/example/Documents/report.pdf";
  const tree: Root = {
    type: "root",
    children: [
      {
        type: "paragraph",
        children: [
          {
            type: "link",
            url: path,
            children: [
              {
                type: "strong",
                children: [{ type: "text", value: "Quarterly report" }],
              },
            ],
          },
        ],
      },
    ],
  };
  remarkLocalFiles()(tree);
  expect(tree.children[0]).toMatchObject({
    children: [
      {
        url: path,
        data: {
          hProperties: {
            "data-local-path": path,
            "data-local-label": "Quarterly report",
          },
        },
      },
    ],
  });
});

test("deliverable lists use filenames, recognize subtitles, and separate HTML from list markers", () => {
  expect(fileName("/long/workspace/sample-log.txt")).toBe("sample-log.txt");
  expect(fileName("C:\\Users\\example\\Documents\\")).toBe("Documents");
  for (const extension of ["srt", "vtt", "ass", "ssa"])
    expect(isLocalReference(`subtitles.${extension}`)).toBe(true);
  const tree: Root = {
    type: "root",
    children: [
      {
        type: "list",
        ordered: false,
        children: [
          "sample-captions.srt",
          "workspace/sample-page.html",
          "workspace/recording.mp3",
        ].map((path) => ({
          type: "listItem",
          children: [
            {
              type: "paragraph",
              children: [
                { type: "inlineCode", value: path },
                { type: "text", value: "：说明" },
              ],
            },
          ],
        })),
      },
    ],
  };
  remarkLocalFiles()(tree);
  expect(tree.children.map((node) => node.type)).toEqual([
    "list",
    "paragraph",
    "paragraph",
    "list",
  ]);
  expect(tree.children[1]).toMatchObject({
    children: [{ type: "link", url: "workspace/sample-page.html" }],
  });
  expect(tree.children[2]).toMatchObject({
    children: [{ type: "text", value: "说明" }],
  });
});

test("same filenames receive directory context without converting numbered lists into artifacts", () => {
  const tree: Root = {
    type: "root",
    children: [
      {
        type: "list",
        ordered: true,
        start: 3,
        children: ["desktop/index.html", "mobile/index.html"].map((path) => ({
          type: "listItem",
          children: [
            {
              type: "paragraph",
              children: [{ type: "inlineCode", value: path }],
            },
          ],
        })),
      },
    ],
  };
  remarkLocalFiles()(tree);
  expect(tree.children).toHaveLength(1);
  expect(tree.children[0]).toMatchObject({
    type: "list",
    start: 3,
    children: [
      {
        children: [
          {
            children: [
              {
                data: {
                  hProperties: { "data-local-label": "desktop/index.html" },
                },
              },
            ],
          },
        ],
      },
      {
        children: [
          {
            children: [
              {
                data: {
                  hProperties: { "data-local-label": "mobile/index.html" },
                },
              },
            ],
          },
        ],
      },
    ],
  });
});

test("file descriptions stay outside the clickable filename and before its actions", () => {
  const description = [
    { type: "text" as const, value: "：" },
    {
      type: "strong" as const,
      children: [{ type: "text" as const, value: "字幕" }],
    },
    { type: "text" as const, value: " 12 条" },
  ];
  const tree: Root = {
    type: "root",
    children: [
      {
        type: "paragraph",
        children: [
          { type: "inlineCode", value: "sample-captions.srt" },
          ...description,
        ],
      },
      {
        type: "paragraph",
        children: [{ type: "inlineCode", value: "sample-log.txt" }],
      },
      {
        type: "paragraph",
        children: [
          { type: "inlineCode", value: "notes.md" },
          { type: "text", value: " Meeting notes" },
        ],
      },
      {
        type: "paragraph",
        children: [
          { type: "inlineCode", value: "a.txt" },
          { type: "text", value: " and " },
          { type: "inlineCode", value: "b.txt" },
        ],
      },
    ],
  };
  remarkLocalFiles()(tree);
  expect(tree.children[0]).toMatchObject({
    children: [
      {
        url: "sample-captions.srt",
        children: description,
        data: { hProperties: { "data-local-description": "true" } },
      },
    ],
  });
  expect(tree.children[1]).toMatchObject({
    children: [
      { url: "sample-log.txt", children: [{ value: "sample-log.txt" }] },
    ],
  });
  expect(tree.children[2]).toMatchObject({
    children: [{ url: "notes.md", children: [{ value: " Meeting notes" }] }],
  });
  expect(tree.children[3]).toMatchObject({
    children: [{ url: "a.txt" }, { value: " and " }, { url: "b.txt" }],
  });
});
