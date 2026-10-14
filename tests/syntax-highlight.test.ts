import { expect, test } from "vitest";
import {
  highlightCode,
  isPlainTextLanguage,
} from "../src/renderer/src/lib/syntax-highlight";

test.each([
  ["js", 'const label = "sample";'],
  ["TS", "const count: number = 3;"],
  ["python", 'print("sample")'],
  ["sh", 'echo "sample"'],
  ["json", '{"count": 3}'],
  ["yml", "count: 3"],
  ["sql", "SELECT count FROM items;"],
  ["html", '<p class="sample">Hello</p>'],
  ["go", 'func main() { fmt.Println("sample") }'],
  ["rs", 'fn main() { println!("sample"); }'],
  ["cpp", "int main() { return 0; }"],
  ["java", "public class Sample {}"],
])("highlights common languages and aliases: %s", (language, code) => {
  expect(highlightCode(code, language)).toContain('class="hljs-');
});

test.each(["", "text", "plaintext", "txt", "plain", " TEXT "])(
  "plain text stays unmodified: %s",
  (language) => {
    expect(isPlainTextLanguage(language)).toBe(true);
    expect(highlightCode("const label = 3;", language)).toBeUndefined();
  },
);

test("unknown languages and large blocks fall back to plain text", () => {
  expect(
    highlightCode("const label = 3;", "unrecognized-language"),
  ).toBeUndefined();
  expect(highlightCode("x".repeat(100_001), "js")).toBeUndefined();
});

test("HTML-looking code is escaped rather than executable", () => {
  const html = highlightCode('<script>alert("sample")</script>', "html")!;
  expect(html).toContain("&lt;");
  expect(html).not.toContain("<script>");
});
