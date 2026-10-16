import { expect, test } from "vitest";
import { SearchCache, type SearchIndex } from "../src/main/search-cache";

const index = (text: string): SearchIndex => ({
  key: "file/1/1",
  source: text,
  parsed: new Map([[`**${text}**`, text]]),
  messages: [{ text, folded: text }],
});

test("evicts by retained bytes, refreshes recency, and releases removed entries", () => {
  const cache = new SearchCache(3500);
  for (const id of ["a", "b", "c", "d"]) cache.set(id, index(id.repeat(48)));
  expect(cache.get("a")?.messages).toBeDefined();
  cache.set("e", index("e".repeat(48)));
  expect(cache.get("b")).toBeUndefined();
  for (const id of ["a", "c", "d", "e"]) expect(cache.get(id)).toBeDefined();
  expect(cache.bytes).toBeLessThanOrEqual(cache.limit);
  cache.delete("a");
  cache.clear();
  expect(cache.bytes).toBe(0);
});

test("recounts replacements and bounds even individually oversized replies", () => {
  const cache = new SearchCache(2000);
  cache.set("a", index("small"));
  cache.set("a", index("larger"));
  const replacementBytes = cache.bytes;
  const fresh = new SearchCache(2000);
  fresh.set("a", index("larger"));
  expect(replacementBytes).toBe(fresh.bytes);
  cache.set("a", index("huge".repeat(5000)));
  const partial = cache.get("a")!;
  expect(partial.key).toBe("file/1/1");
  expect(partial.messages).toBeUndefined();
  expect(partial.parsed.size).toBe(0);
  expect(partial.source).toBeUndefined();
  expect(cache.bytes).toBeLessThanOrEqual(cache.limit);
});

test("keeps recent parsed messages and compact source when a full index exceeds the budget", () => {
  const cache = new SearchCache(10000);
  const replies = Array.from(
    { length: 12 },
    (_, i) => `reply-${i} ${"body ".repeat(15)}`,
  );
  cache.set("large", {
    key: "current",
    source: "replybody0123456789 ",
    parsed: new Map(replies.map((text) => [`**${text}**`, text])),
    messages: replies.map((text) => ({ text, folded: text })),
  });
  const partial = cache.get("large")!;
  expect(partial.messages).toBeUndefined();
  expect(partial.source).toBe("replybody0123456789 ");
  expect(partial.parsed.size).toBeGreaterThan(0);
  expect(partial.parsed.size).toBeLessThan(replies.length);
  expect(partial.parsed.has(`**${replies.at(-1)}**`)).toBe(true);
  expect(cache.bytes).toBeLessThanOrEqual(cache.limit);
  cache.delete("large");
  expect(cache.bytes).toBe(0);
});

function largeIndex(count = 100): SearchIndex {
  const replies = Array.from(
    { length: count },
    (_, i) => `reply-${i} ${"body ".repeat(15)}`,
  );
  return {
    key: "large",
    source: "replybody0123456789 ",
    parsed: new Map(replies.map((text) => [`**${text}**`, text])),
    messages: replies.map((text) => ({ text, folded: text })),
  };
}

test("an oversized conversation coexists with small entries before and after its insertion", () => {
  const cache = new SearchCache(10000);
  cache.set("small-1", index("a".repeat(40)));
  cache.set("small-2", index("b".repeat(40)));
  const before = cache.bytes;
  cache.set("large", largeIndex());
  expect(cache.bytes - before).toBeLessThanOrEqual(cache.limit / 4);
  expect(cache.get("small-1")?.messages).toBeDefined();
  expect(cache.get("small-2")?.messages).toBeDefined();
  expect(cache.get("large")?.parsed.size).toBeGreaterThan(0);
  // Make the large entry oldest, then exercise a subsequent cache write.
  cache.get("small-1");
  cache.get("small-2");
  cache.set("small-3", index("c".repeat(40)));
  expect(cache.get("large")?.parsed.size).toBeGreaterThan(0);
  for (const id of ["small-1", "small-2", "small-3"])
    expect(cache.get(id)?.messages).toBeDefined();
  expect(cache.bytes).toBeLessThanOrEqual(cache.limit);
});

test("a complete index below the global budget still observes the per-conversation limit", () => {
  const full = largeIndex(4);
  const roomy = new SearchCache(100000);
  roomy.set("large", full);
  expect(roomy.get("large")?.messages).toBeDefined();
  expect(roomy.bytes).toBeLessThan(10000);
  expect(roomy.bytes).toBeGreaterThan(2500);
  const cache = new SearchCache(10000);
  cache.set("large", full);
  expect(cache.get("large")?.messages).toBeUndefined();
  expect(cache.get("large")?.parsed.size).toBeGreaterThan(0);
  expect(cache.bytes).toBeLessThanOrEqual(cache.limit / 4);
});

test("counts reply text shared with its parse result once", () => {
  const full = largeIndex(4);
  const cache = new SearchCache(100000);
  cache.set("full", full);
  const withMessages = cache.bytes;
  cache.set("parsed", { ...full, messages: undefined });
  const messageBytes = withMessages - (cache.bytes - withMessages);
  // Messages add only their folded text; their text is the parsed result.
  expect(messageBytes).toBe(
    full.messages!.reduce(
      (total, message) => total + 64 + message.folded.length * 2,
      0,
    ),
  );
  // A complete index exactly at the per-conversation limit stays complete.
  const exact = new SearchCache(withMessages * 4);
  exact.set("full", full);
  expect(exact.get("full")?.messages).toBe(full.messages);
  expect(exact.bytes).toBe(withMessages);
});

test("still counts a prompt equal to a reply's parsed text", () => {
  const text = "same text";
  const index: SearchIndex = {
    key: "k",
    parsed: new Map([[`**${text}**`, text]]),
    messages: [
      { text, folded: text },
      { text, folded: text },
    ],
  };
  const cache = new SearchCache(100000);
  cache.set("both", index);
  const both = cache.bytes;
  cache.set("reply", { ...index, messages: [{ text, folded: text }] });
  expect(both - (cache.bytes - both)).toBe(64 + text.length * 4);
});
