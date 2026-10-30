import { expect, test } from "vitest";
import type { Root } from "mdast";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { remarkCjkAutolinks } from "../src/shared/remark-cjk-autolinks";

function parse(text: string) {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkCjkAutolinks);
  const root = processor.runSync(processor.parse(text), {
    value: text,
  }) as Root;
  const paragraph = root.children[0];
  if (paragraph.type !== "paragraph") throw new Error("Expected paragraph");
  return paragraph.children;
}

test.each([
  "）。说明会更新，请查看页面上的最新内容。",
  "，请查看来源。",
  "。\n下一段说明",
])("literal URL stops before Chinese punctuation: %s", (suffix) => {
  const url = "https://example.com/weather.html";
  const nodes = parse(url + suffix);
  expect(nodes[0]).toMatchObject({
    type: "link",
    url,
    children: [{ type: "text", value: url }],
  });
  expect(
    nodes
      .slice(1)
      .map((node) => ("value" in node ? node.value : ""))
      .join(""),
  ).toBe(suffix);
});

test("explicit links, angle autolinks and valid Unicode URL paths retain their intent", () => {
  for (const source of [
    "[www.example.com（说明）](https://example.com/目录（示例）)",
    "[说明已更新，打开页面查看](https://example.com/目录（示例）)",
    "<https://example.com/目录（示例）>",
    "https://example.com/目录/示例?版本=当前&mode=daily",
  ]) {
    const plain = unified().use(remarkParse).use(remarkGfm).parse(source)
      .children[0];
    if (plain.type !== "paragraph") throw new Error("Expected paragraph");
    expect(parse(source)).toEqual(plain.children);
  }
});

test.each(["https://", "http://", "www.", "WWW."])(
  "%s literal URLs stop before every supported CJK boundary",
  (prefix) => {
    const label = prefix + "example.com/目录?q=示例&mode=daily#section";
    const url = /^www\./i.test(label) ? "http://" + label : label;
    for (const punctuation of "，。！？；、（）【】“”‘’") {
      const suffix = punctuation + "请查看来源。";
      expect(parse(label + suffix)).toMatchObject([
        { type: "link", url, children: [{ type: "text", value: label }] },
        { type: "text", value: suffix },
      ]);
    }
  },
);

test.each(["/guide/intro/", "page details"])(
  "restores swallowed inline code: %s",
  (code) => {
    const nodes = parse(
      `示例文档站点 www.docs.example.test（页面导航说明、\`${code}\` 站点说明，支持代码与标点解析）`,
    );
    expect(nodes).toMatchObject([
      { type: "text", value: "示例文档站点 " },
      {
        type: "link",
        url: "http://www.docs.example.test",
        children: [{ type: "text", value: "www.docs.example.test" }],
      },
      { type: "text", value: "（页面导航说明、" },
      { type: "inlineCode", value: code },
      { type: "text", value: " 站点说明，支持代码与标点解析）" },
    ]);
  },
);

test("recovers emphasis and subsequent links without changing explicit links or code", () => {
  const nodes = parse(
    "www.example.com（**page details**，https://other.example.com。详情 [来源][ref]）\n\n[ref]: https://example.com/目录（示例）",
  );
  expect(nodes).toMatchObject([
    { type: "link", url: "http://www.example.com" },
    { type: "text", value: "（" },
    { type: "strong", children: [{ type: "text", value: "page details" }] },
    { type: "text", value: "，" },
    { type: "link", url: "https://other.example.com" },
    { type: "text", value: "。详情 " },
    { type: "linkReference", identifier: "ref" },
    { type: "text", value: "）" },
  ]);
  expect(
    parse("`www.example.com（说明）` www.example.com，请看")[0],
  ).toMatchObject({
    type: "inlineCode",
    value: "www.example.com（说明）",
  });
});
