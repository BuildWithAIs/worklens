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
  const root = processor.runSync(processor.parse(text), { value: text }) as Root;
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
