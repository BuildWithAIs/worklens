import { expect, test } from "vitest";
import type { Root } from "mdast";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { remarkCjkAutolinks } from "../src/renderer/src/lib/remark-cjk-autolinks";

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
  "）。预报会更新，出门前建议再看一次当天实时。",
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
    "[www.example.com（说明）](https://example.com/天气（南京）)",
    "[预报会更新，出门前再看](https://example.com/天气（南京）)",
    "<https://example.com/天气（南京）>",
    "https://example.com/天气/南京?日期=今天&mode=daily",
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
    const label = prefix + "example.com/天气?q=南京&mode=daily#section";
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

test.each(["/gk/xdnt/", "opening hours"])(
  "restores swallowed inline code: %s",
  (code) => {
    const nodes = parse(
      `南京图书馆官网 www.jslib.org.cn（首页开馆时间、\`${code}\` 南图简介，均返回 200 且内容正常）`,
    );
    expect(nodes).toMatchObject([
      { type: "text", value: "南京图书馆官网 " },
      {
        type: "link",
        url: "http://www.jslib.org.cn",
        children: [{ type: "text", value: "www.jslib.org.cn" }],
      },
      { type: "text", value: "（首页开馆时间、" },
      { type: "inlineCode", value: code },
      { type: "text", value: " 南图简介，均返回 200 且内容正常）" },
    ]);
  },
);

test("recovers emphasis and subsequent links without changing explicit links or code", () => {
  const nodes = parse(
    "www.example.com（**opening hours**，https://other.example.com。详情 [来源][ref]）\n\n[ref]: https://example.com/天气（南京）",
  );
  expect(nodes).toMatchObject([
    { type: "link", url: "http://www.example.com" },
    { type: "text", value: "（" },
    { type: "strong", children: [{ type: "text", value: "opening hours" }] },
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
