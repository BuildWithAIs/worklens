import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { expect, test } from "vitest";
import { preprocessMarkdownMath } from "../src/shared/markdown-math";
import { remarkCjkAutolinks } from "../src/shared/remark-cjk-autolinks";

function render(text: string) {
  return renderToStaticMarkup(
    createElement(ReactMarkdown, {
      children: preprocessMarkdownMath(text),
      remarkPlugins: [remarkGfm, remarkMath, remarkCjkAutolinks],
      rehypePlugins: [[rehypeKatex, { trust: false, maxSize: 10 }]],
    }),
  );
}

test.each([
  String.raw`Map: $x \mapsto x^2$`,
  String.raw`Map: \(x \mapsto x^2\)`,
  "$0$ and $5x = 10$",
])("renders inline math with accessible MathML: %s", (text) => {
  expect(render(text)).toContain('class="katex"');
  expect(render(text)).toContain("<math");
});

test.each([
  "$$\nx^2 + y^2 = 1\n$$",
  "$$x^2 + y^2 = 1$$",
  String.raw`\[\frac{1}{2}\]`,
  "Before\\[\nx^2 + y^2 = 1\n\\]After",
])("renders display math: %s", (text) => {
  const html = render(text);
  expect(html).toContain('class="katex-display"');
  expect(html).not.toContain("katex-error");
});

test.each([
  "Prices: $12 and $24; total $36.",
  "价格 $12、$24，共 $36。",
  "Range $12-$24; $1,299.50.",
  String.raw`Escaped \$12 and \$24.`,
])("preserves currency as prose: %s", (text) => {
  const html = render(text);
  expect(html).not.toContain('class="katex"');
  expect(html).toContain("$12");
  expect(html).toContain("$24");
});

test.each([
  "`$12 and \\(x^2\\)`",
  "```text\n$12 and \\(x^2\\)\n```",
  "```text\n$12 and \\(x^2\\)",
  "~~~text\n$12 and \\(x^2\\)\n~~~",
  "~~~text\n$12 and \\(x^2\\)",
  "    $12 and \\(x^2\\)",
  "> ~~~text\n> $12 and \\(x^2\\)\n> ~~~",
])("keeps code verbatim: %s", (text) => {
  expect(preprocessMarkdownMath(text)).toBe(text);
  expect(render(text)).not.toContain('class="katex"');
});

test("currency, math, CJK links, and tables coexist", () => {
  const html = render(
    "Cost $12 and $24. Formula $x^2$. www.example.com。详情\n\n| Value | Formula |\n| --- | --- |\n| 2 | $x^2$ |",
  );
  expect(html).toContain("Cost $12 and $24.");
  expect(html.match(/class="katex"/g)).toHaveLength(2);
  expect(html).toContain('href="http://www.example.com"');
  expect(html).toContain("<table>");
});

test("invalid and unfinished math never prevents neighboring text rendering", () => {
  const html = render(String.raw`Before $\frac{$ after.`);
  expect(html).toContain("katex-error");
  expect(html).toContain("Before");
  expect(html).toContain("after.");
  const text = String.raw`Cost $12 and $24. Expression \(\frac{1}{2}\).`;
  for (let end = 0; end <= text.length; end++)
    expect(() => render(text.slice(0, end))).not.toThrow();
});

test("math cannot inject trusted HTML or JavaScript links", () => {
  const html = render(String.raw`$\href{javascript:alert(1)}{click}$`);
  expect(html).not.toContain('href="javascript:');
  expect(html).not.toContain("<script");
});
