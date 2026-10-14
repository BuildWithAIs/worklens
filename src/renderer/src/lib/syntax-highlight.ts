import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

export const syntaxHighlighter = hljs.newInstance();
for (const [name, definition] of Object.entries({
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  markdown,
  php,
  powershell,
  python,
  ruby,
  rust,
  shell,
  sql,
  swift,
  typescript,
  xml,
  yaml,
}))
  syntaxHighlighter.registerLanguage(name, definition);

const plainTextLanguages = new Set(["", "text", "plaintext", "txt", "plain"]);

export function isPlainTextLanguage(language: string) {
  return plainTextLanguages.has(language.trim().toLowerCase());
}

/** Unknown languages and large snippets retain readable, unmodified text. */
export function highlightCode(code: string, language: string) {
  const normalized = language.trim().toLowerCase();
  if (
    isPlainTextLanguage(normalized) ||
    code.length > 100_000 ||
    !syntaxHighlighter.getLanguage(normalized)
  )
    return undefined;
  try {
    return syntaxHighlighter.highlight(code, { language: normalized }).value;
  } catch {
    return undefined;
  }
}
