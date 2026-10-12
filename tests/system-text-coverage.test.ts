import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { systemText } from "../src/renderer/src/lib/system-text";

// Main-process errors and diagnostics in these files reach the UI. The
// renderer translates them by wording, so a rewording must update the table.
// Tool results for the model are not listed: conversation content is untranslated.
const connectorFiles = readdirSync("src/main/connectors", {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .flatMap((entry) =>
    ["connection.ts", "connection-test.ts"].map((name) =>
      join("src/main/connectors", entry.name, name),
    ),
  )
  .filter((path) => {
    try {
      readFileSync(path);
      return true;
    } catch {
      return false;
    }
  });
const files = [
  "src/main/index.ts",
  "src/main/ipc.ts",
  "src/main/agent-service.ts",
  "src/main/storage.ts",
  "src/main/providers.ts",
  "src/main/skills.ts",
  "src/main/mcp-service.ts",
  "src/main/validation.ts",
  ...connectorFiles,
];
const literal = String.raw`(["\x60])((?:\\.|(?!\1).)*?[一-鿿](?:\\.|(?!\1).)*?)\1`;
const patterns = [
  new RegExp(String.raw`new Error\(\s*` + literal, "g"),
  new RegExp(
    String.raw`diagnostics\.push\(\s*(?:this\.redact\()?` + literal,
    "g",
  ),
];
const messages = files.flatMap((file) => {
  const source = readFileSync(file, "utf8");
  return patterns.flatMap((pattern) =>
    [...source.matchAll(pattern)].map((match) => ({
      file,
      // Interpolated values stand in for counts, IDs and details.
      text: match[2].replace(/\$\{[^}]*\}/g, "1"),
    })),
  );
});

test("finds user-facing main-process messages", () => {
  expect(messages.length).toBeGreaterThan(40);
});

test.each(messages)("translates $file: $text", ({ text }) => {
  expect(systemText(text, "en")).not.toMatch(/[一-鿿]/);
});
