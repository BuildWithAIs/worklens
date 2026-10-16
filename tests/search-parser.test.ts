import { afterAll, expect, test } from "vitest";
import { SearchParser, searchParser } from "../src/main/search-parser";
import {
  loadMarkdownParser,
  searchableMessages,
  indexSearchText,
  mayContain,
} from "../src/main/conversation-search";

// Exercise the same default worker URL as AgentService's singleton.
const reader = new SearchParser();
afterAll(() => {
  reader.close();
  searchParser.close();
});

test("the default search path handles long replies without a prior desktop build", async () => {
  await loadMarkdownParser();
  const markdown = "A **long** reply with $12 and $24. ".repeat(400);
  const [message] = await searchableMessages([
    { id: "long", role: "assistant", text: markdown },
  ]);
  expect(message.text).toContain("A long reply with $12 and $24.");
  expect(message.folded).toContain("a long reply with $12 and $24.");
});

test("parses long Markdown while main-thread timers continue to run", async () => {
  await reader.read("warm up", "markdown", () => undefined);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  try {
    const markdown =
      "A **review** paragraph with [link](https://example.com) and `code`.\n\n".repeat(
        6000,
      );
    const result = await reader.read(markdown, "markdown", () => undefined);
    expect(result.text).toContain("A review paragraph with link and code.");
    expect(ticks).toBeGreaterThan(5);
  } finally {
    clearInterval(timer);
  }
});

test("cancels work in progress and accepts a fresh search afterward", async () => {
  let cancelled = false;
  const pending = reader.read(
    "**long** text.\n\n".repeat(30000),
    "markdown",
    () => {
      if (cancelled) throw new Error("cancelled by test");
      return undefined;
    },
  );
  const timer = setTimeout(() => {
    cancelled = true;
  }, 15);
  try {
    await expect(pending).rejects.toThrow("cancelled by test");
  } finally {
    clearTimeout(timer);
  }
  expect(
    await reader.read("Cost $12 and $24.", "markdown", () => undefined),
  ).toEqual({
    text: "Cost $12 and $24.",
    folded: "cost $12 and $24.",
  });
});

test("prefilter retains only folded characters for short and worker-sized sources", async () => {
  await loadMarkdownParser();
  const source = "COIN &euro;25 😊 ";
  const small = await indexSearchText(source, "source", () => undefined);
  const large = await indexSearchText(
    source.repeat(1000),
    "source",
    () => undefined,
  );
  expect(large).toEqual(small);
  expect(large.text).toBe("");
  expect(large.folded.length).toBeLessThan(30);
  expect(mayContain(large.folded, "€25")).toBe(true);
  expect(mayContain(large.folded, "coin")).toBe(true);
  expect(mayContain(large.folded, "😊")).toBe(true);
  expect(mayContain(large.folded, "zinc")).toBe(false);
});
