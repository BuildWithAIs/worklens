import { expect, test } from "vitest";
import { fileName, shortUrl } from "../src/renderer/src/lib/link-label";
import { isLocalReference } from "../src/shared/file-references";
import { remarkLocalFiles } from "../src/renderer/src/lib/remark-local-files";
import type { Root } from "mdast";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { remarkCjkAutolinks } from "../src/renderer/src/lib/remark-cjk-autolinks";

test("website routes remain intact after CJK URL and local-file parsing", () => {
  const source =
    "南京图书馆官网 www.jslib.org.cn（首页开馆时间、`/gk/xdnt/` 南图简介）\n\n接口 /api/v1/items，参考 `/docs/report.pdf`。";
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkCjkAutolinks)
    .use(remarkLocalFiles, { producedPaths: new Set<string>() });
  const tree = processor.runSync(processor.parse(source), {
    value: source,
  }) as Root;
  expect(tree.children[0]).toMatchObject({
    children: [
      { type: "text", value: "南京图书馆官网 " },
      { type: "link", url: "http://www.jslib.org.cn" },
      { type: "text", value: "（首页开馆时间、" },
      { type: "inlineCode", value: "/gk/xdnt/" },
      { type: "text", value: " 南图简介）" },
    ],
  });
  expect(tree.children[1]).toMatchObject({
    children: [
      { type: "text", value: "接口 /api/v1/items，参考 " },
      { type: "inlineCode", value: "/docs/report.pdf" },
      { type: "text", value: "。" },
    ],
  });
});

test.each([
  "/Users/example/Documents/report.pdf",
  "/home/example/report.pdf",
  "/tmp/report.pdf",
  "/private/tmp/report.pdf",
  "C:\\Users\\example\\report.pdf",
  "~/Documents/report.pdf",
  "./report.pdf",
  "workspace/report.pdf",
  "artifacts/report.pdf",
  "report.pdf",
])("produced local references receive file actions: %s", (path) => {
  const tree: Root = {
    type: "root",
    children: [
      { type: "paragraph", children: [{ type: "inlineCode", value: path }] },
    ],
  };
  remarkLocalFiles({ producedPaths: new Set([path]) })(tree);
  expect(tree.children[0]).toMatchObject({
    children: [
      { type: "link", data: { hProperties: { "data-local-path": path } } },
    ],
  });
});

test("explicit file links support custom filesystem roots", () => {
  const processor = unified()
    .use(remarkParse)
    .use(remarkLocalFiles, { producedPaths: new Set(["/custom/report.pdf"]) });
  const tree = processor.runSync(
    processor.parse("[Report](/custom/report.pdf)"),
  ) as Root;
  expect(tree.children[0]).toMatchObject({
    children: [
      {
        type: "link",
        data: {
          hProperties: {
            "data-local-path": "/custom/report.pdf",
            "data-local-label": "Report",
          },
        },
      },
    ],
  });
});

test("unproduced suggestions retain code, descriptions and list structure", () => {
  const source =
    "- `国学入门计划.md`：12 周读什么\n- `workspace/计划.html`：入门课程\n- [参考表](表格.md)：关系速查";
  const processor = unified().use(remarkParse).use(remarkLocalFiles, {
    producedPaths: new Set<string>(),
  });
  const tree = processor.runSync(processor.parse(source)) as Root;
  expect(tree.children).toHaveLength(1);
  expect(tree.children[0]).toMatchObject({
    type: "list",
    children: [
      {
        children: [
          {
            children: [
              { type: "inlineCode", value: "国学入门计划.md" },
              { type: "text", value: "：12 周读什么" },
            ],
          },
        ],
      },
      {
        children: [
          {
            children: [
              { type: "inlineCode", value: "workspace/计划.html" },
              { type: "text", value: "：入门课程" },
            ],
          },
        ],
      },
      {
        children: [
          {
            children: [
              { type: "text", value: "参考表" },
              { type: "text", value: "：关系速查" },
            ],
          },
        ],
      },
    ],
  });
});

test("only produced file candidates become deliverables", () => {
  const processor = unified()
    .use(remarkParse)
    .use(remarkLocalFiles, {
      producedPaths: new Set(["workspace/done.md", "/custom/actual.html"]),
    });
  const tree = processor.runSync(
    processor.parse(
      "`workspace/done.md`\n\n`later.md`\n\n`/custom/actual.html`",
    ),
  ) as Root;
  expect(tree.children[0]).toMatchObject({
    children: [{ type: "link", url: "workspace/done.md" }],
  });
  expect(tree.children[1]).toMatchObject({
    children: [{ type: "inlineCode", value: "later.md" }],
  });
  expect(tree.children[2]).toMatchObject({
    children: [{ type: "link", url: "/custom/actual.html" }],
  });
});

test.each([
  "你的 `statusline-command.sh` 已经在读取配置。",
  "`statusline-command.sh` 已经在读取配置。",
  "当前配置在 /Users/example/config.toml，请保留。",
  "| 配置 |\n| --- |\n| `statusline-command.sh` |",
])(
  "existing files mentioned in prose remain ordinary Markdown: %s",
  (source) => {
    const parser = unified().use(remarkParse).use(remarkGfm);
    const tree = parser.parse(source);
    const original = structuredClone(tree);
    remarkLocalFiles({
      producedPaths: new Set(),
    })(tree);
    expect(tree).toEqual(original);
  },
);

test("a file entry does not enhance references inside its description", () => {
  const parser = unified().use(remarkParse);
  const tree = parser.parse("`report.md`：说明 `config.toml` 的用途");
  remarkLocalFiles({ producedPaths: new Set(["report.md"]) })(tree);
  expect(tree.children[0]).toMatchObject({
    children: [
      {
        type: "link",
        url: "report.md",
        children: [
          { type: "text", value: "：说明 " },
          { type: "inlineCode", value: "config.toml" },
          { type: "text", value: " 的用途" },
        ],
      },
    ],
  });
});

test.each([true, false])(
  "produced HTML in a sentence remains an artifact (inline code: %s)",
  (code) => {
    const path = "/Users/example/.worklens-dev/runtime/index.html";
    const missing = "/Users/example/.worklens-dev/runtime/later.html";
    const source = `已创建 ${code ? "`" + path + "`" : path}。\n\n以后可以生成 \`${missing}\`。\n\n你的 \`statusline-command.sh\` 已在读取配置。\n\n\`\`\`bash\nopen ${path}\n\`\`\``;
    const parser = unified().use(remarkParse);
    const tree = parser.parse(source);
    remarkLocalFiles({
      producedPaths: new Set([path]),
    })(tree);
    expect(tree.children[0]).toMatchObject({
      children: [
        { type: "text", value: "已创建 " },
        {
          type: "link",
          url: path,
          data: { hProperties: { "data-local-path": path } },
        },
        { type: "text", value: "。" },
      ],
    });
    expect(tree.children[1]).toMatchObject({
      children: [
        { type: "text", value: "以后可以生成 " },
        { type: "inlineCode", value: missing },
        { type: "text", value: "。" },
      ],
    });
    expect(tree.children[2]).toMatchObject({
      children: [
        { type: "text", value: "你的 " },
        { type: "inlineCode", value: "statusline-command.sh" },
        { type: "text", value: " 已在读取配置。" },
      ],
    });
    expect(tree.children[3]).toMatchObject({
      type: "code",
      lang: "bash",
      value: `open ${path}`,
    });
  },
);

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
  remarkLocalFiles({ producedPaths: new Set([path]) })(tree);
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
  remarkLocalFiles({
    producedPaths: new Set([
      "sample-captions.srt",
      "workspace/sample-page.html",
      "workspace/recording.mp3",
    ]),
  })(tree);
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
  remarkLocalFiles({
    producedPaths: new Set(["desktop/index.html", "mobile/index.html"]),
  })(tree);
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
          { type: "text", value: "：Meeting notes" },
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
  remarkLocalFiles({
    producedPaths: new Set([
      "sample-captions.srt",
      "sample-log.txt",
      "notes.md",
    ]),
  })(tree);
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
    children: [{ url: "notes.md", children: [{ value: "：Meeting notes" }] }],
  });
  expect(tree.children[3]).toMatchObject({
    children: [
      { type: "inlineCode", value: "a.txt" },
      { value: " and " },
      { type: "inlineCode", value: "b.txt" },
    ],
  });
});

test.each(["html", "png", "txt", "pdf", "docx", "sh", "toml"])(
  "output provenance, not extension or paragraph position, enables %s",
  (extension) => {
    const path = `/tmp/result.${extension}`;
    const parser = unified().use(remarkParse);
    for (const source of [`已生成 \`${path}\`。`, `已生成 ${path}。`]) {
      const ordinary = parser.parse(source);
      const original = structuredClone(ordinary);
      remarkLocalFiles()(ordinary);
      expect(ordinary).toEqual(original);
      const produced = parser.parse(source);
      remarkLocalFiles({ producedPaths: new Set([path]) })(produced);
      expect(produced.children[0]).toMatchObject({
        children: [
          { type: "text", value: "已生成 " },
          {
            type: "link",
            url: path,
            data: { hProperties: { "data-local-path": path } },
          },
          { type: "text", value: "。" },
        ],
      });
    }
  },
);
