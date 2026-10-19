import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { AgentService } from "../src/main/agent-service";
import { SearchCache } from "../src/main/search-cache";
import * as searchMarkdown from "../src/main/search-markdown";
import * as conversationSearch from "../src/main/conversation-search";
const realSearchable = conversationSearch.searchableMessages;
import {
  loadMarkdownParser,
  markdownText,
  mayContain,
  prefilterSource,
  searchSnippet,
  searchableMessages,
} from "../src/main/conversation-search";
import { findSearchMatch, foldSearchText } from "../src/shared/search-text";
import { mockServer, fixtureModel } from "./mock-server";
import type {
  ChatEvent,
  ConversationView,
  Selection,
} from "../src/shared/contracts";

const cleanups: (() => Promise<unknown>)[] = [];
beforeAll(loadMarkdownParser);
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// The fold before native lowercasing, one character at a time.
function foldEach(text: string) {
  let result = "";
  for (const character of text) {
    const folded = character.toLowerCase();
    result += folded.length === character.length ? folded : character;
  }
  return result;
}

test("folds case without moving offsets", () => {
  expect(foldSearchText("Hello 搓手指 İ")).toHaveLength(
    "Hello 搓手指 İ".length,
  );
  // Every character folds as it did one at a time, alone or among others,
  // including Σ at the end of a word.
  const all = Array.from({ length: 0x110000 }, (_, code) =>
    code >= 0xd800 && code <= 0xdfff ? "" : String.fromCodePoint(code),
  );
  for (const character of all)
    expect(foldSearchText(character)).toBe(foldEach(character));
  const text = all.join("");
  expect(foldSearchText(text)).toBe(foldEach(text));
  expect(foldSearchText(`${text}ΟΔΟΣ`)).toBe(foldEach(`${text}ΟΔΟΣ`));
  expect(foldSearchText("ΟΔΟΣ ΙΣ")).toBe("οδοσ ισ");
  expect(foldSearchText("ΣİΣ ΟΣİ")).toBe(foldEach("ΣİΣ ΟΣİ"));
  // Long text folds at native speed, so a matched message can't hold the
  // main process; Greek and Turkish text, with Σ and İ throughout, too.
  // Compared on the same machine, best of three, so a slow or busy runner
  // doesn't fail it: the fold before was no faster than one at a time.
  const fastest = (fold: (text: string) => string, text: string) => {
    let best = Infinity;
    for (let run = 0; run < 3; run++) {
      const started = performance.now();
      fold(text);
      best = Math.min(best, performance.now() - started);
    }
    return best;
  };
  for (const long of [
    "Some Words 搓手指. ".repeat(200_000),
    "ΟΔΟΣ İstanbul σας. ".repeat(200_000),
  ]) {
    expect(foldSearchText(long)).toBe(foldEach(long));
    expect(fastest(foldSearchText, long) * 3).toBeLessThan(
      fastest(foldEach, long),
    );
  }
  expect(findSearchMatch("Say HELLO", foldSearchText("hello"))).toBe(4);
  expect(findSearchMatch("分析搓手指心理", "搓手指")).toBe(2);
  expect(findSearchMatch("anything", "")).toBe(-1);
});

test("builds snippets around the match with collapsed whitespace", () => {
  const text = `${"a".repeat(60)}\n\nNeedle here\n${"b".repeat(200)}`;
  const snippet = searchSnippet(text, text.indexOf("Needle"), 6);
  expect(snippet.match).toBe("Needle");
  expect(snippet.before).toMatch(/^…a+ $/);
  expect(snippet.after).toMatch(/^ here b+…$/);
  expect(searchSnippet("Needle", 0, 6)).toEqual({
    before: "",
    match: "Needle",
    after: "",
  });
});

test("reads replies as rendered Markdown", async () => {
  expect(
    markdownText("Use **copper** leaf, see [the docs](https://x.test)."),
  ).toBe("Use copper leaf, see the docs.");
  expect(
    markdownText(
      "## Steps\n\n- one\n- `two`\n\n```ts\nconst a = 1;\n```\n\n| A | B |\n| - | - |\n| x | y |\n\n![chart](c.png) $x^2$",
    ),
  ).toBe("Steps\none\ntwo\nconst a = 1;\nA B\nx y\nchart x^2");
  // Prompts are shown as typed, so their markup stays.
  expect(
    (
      await searchableMessages([
        { id: "u", role: "user", entryId: "t", text: "**raw** prompt" },
        { id: "a", role: "assistant", text: "**copper** leaf" },
      ])
    ).map(({ text }) => text),
  ).toEqual(["copper leaf", "**raw** prompt"]);
});

test("prefilters stored Markdown without missing split phrases", () => {
  const source = foldSearchText(
    "见[这篇文章](https://x.test)的 **copper** leaf",
  );
  expect(mayContain(source, foldSearchText("Copper leaf"))).toBe(true);
  expect(mayContain(source, "这篇文章的")).toBe(true);
  expect(mayContain(source, "zinc")).toBe(false);
  // A character reference renders as a character the source lacks.
  const priced = "Costs &euro;25 or &#x20AC;3, `&amp;` stays";
  expect(markdownText(priced)).toBe("Costs €25 or €3, &amp; stays");
  expect(mayContain(foldSearchText(priced), "€25")).toBe(false);
  expect(mayContain(foldSearchText(prefilterSource(priced)), "€25")).toBe(true);
  expect(prefilterSource("no references")).toBe("no references");
});

test("shares currency, CJK links and math preprocessing with the renderer, keeping code literal", () => {
  expect(markdownText("Cost $12 and $24. Formula $x^2$.")).toBe(
    "Cost $12 and $24. Formula x^2.",
  );
  expect(markdownText("www.example.com（**今天** 很好）")).toBe(
    "www.example.com（今天 很好）",
  );
  expect(markdownText(String.raw`Use \(\frac{a}{b}\) here.`)).toBe(
    String.raw`Use \frac{a}{b} here.`,
  );
  expect(
    markdownText("`**literal** $12 and $24`\n\n```tex\n\\frac{a}{b}\n```"),
  ).toBe("**literal** $12 and $24\n\\frac{a}{b}");
});

test("reuses parsed replies, checks in after every message and drops stale ones", async () => {
  const turn = (text: string) => [
    { id: `u-${text}`, role: "user" as const, entryId: text, text },
    { id: `a-${text}`, role: "assistant" as const, text: `**${text}** reply` },
  ];
  // A cached reply is used as stored rather than parsed again.
  const parsed = new Map([["**one** reply", "cached one"]]);
  let checks = 0;
  const counting = () => void checks++;
  const messages = await searchableMessages(
    [...turn("one"), ...turn("two")],
    counting,
    parsed,
  );
  expect(messages.map(({ text }) => text).slice(0, 2)).toEqual([
    "cached one",
    "two reply",
  ]);
  // Cached or not, every message yields a chance to pause or cancel.
  expect(checks).toBe(4);
  expect([...parsed.keys()]).toEqual(["**one** reply", "**two** reply"]);
  await searchableMessages(turn("three"), counting, parsed);
  expect([...parsed.keys()]).toEqual(["**three** reply"]);
});

test("indexes replies before prompts by turn, skipping tools and thinking", async () => {
  const messages = await searchableMessages([
    { id: "u", role: "user", entryId: "turn-1", text: "First prompt" },
    { id: "a", role: "assistant", text: "", thinking: "hidden thought" },
    { id: "t", role: "tool", text: "tool output" },
    { id: "b", role: "assistant", text: "Reply" },
    { id: "v", role: "user", entryId: "turn-2", text: "Second" },
  ]);
  expect(messages.map(({ text, turnId }) => [text, turnId])).toEqual([
    ["Reply", "turn-1"],
    ["First prompt", "turn-1"],
    ["Second", "turn-2"],
  ]);
});

test("searches the current branch of loaded and stored conversations", async () => {
  const root = await mkdtemp(join(tmpdir(), "worklens-search-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const paths = {
    runtime: join(root, "runtime"),
    sessions: join(root, "sessions"),
    userData: join(root, "app"),
  };
  const server = await mockServer();
  cleanups.push(server.close);
  const modelRuntime = await ModelRuntime.create({
    modelsPath: null,
    authPath: join(root, "auth.json"),
    allowModelNetwork: false,
  });
  modelRuntime.registerProvider("worklens-test", {
    api: "openai-completions",
    baseUrl: server.url,
    apiKey: "fixture",
    models: [fixtureModel],
  });
  await modelRuntime.refresh({ allowNetwork: false });
  const events: ChatEvent[] = [];
  const create = async () => {
    const service = new AgentService(
      modelRuntime,
      paths,
      (event) => events.push(event),
      (text) => text.replaceAll("hunter2", "[redacted]"),
    );
    await service.initialize();
    cleanups.push(() => service.shutdown());
    return service;
  };
  const service = await create();
  const selection: Selection = {
    provider: "worklens-test",
    model: fixtureModel.id,
    thinking: "off",
  };
  const settle = async (view: ConversationView) => {
    await expect
      .poll(() =>
        events.some(
          (event) => event.runId === view.runId && event.type === "run_end",
        ),
      )
      .toBe(true);
    return service.open(view.id);
  };
  const first = await settle(
    await service.send({
      requestId: randomUUID(),
      text: "Original alpha question",
      selection,
    }),
  );
  const original = first.messages.find((m) => m.role === "user")!;
  const edited = await settle(
    await service.editMessage({
      conversationId: first.id,
      requestId: randomUUID(),
      messageId: original.entryId!,
      expectedBranchId: first.branchId!,
      text: "Revised **Beta** question with hunter2",
      images: [],
      selection,
    }),
  );
  const revised = edited.messages.find((m) => m.role === "user")!;
  await service.rename(first.id, "Weekly report");
  // The reply echoes the reference, which renders as €25.
  const priced = await settle(
    await service.send({
      requestId: randomUUID(),
      text: String.raw`Costs &euro;25 per month, or $12 and $24. www.example.com（**今天** 很好） Formula \(\frac{a}{b}\).`,
      selection,
    }),
  );

  const expectations = async (instance: AgentService) => {
    expect(await instance.search("alpha")).toEqual([]);
    const [match] = await instance.search("BETA");
    expect(match).toMatchObject({
      id: first.id,
      title: "Weekly report",
      messageId: revised.entryId,
      // The mock reply echoes the prompt, and replies are preferred.
      snippet: { before: "已完成：Revised ", match: "Beta" },
    });
    expect(match.snippet!.after).toContain("[redacted]");
    // A phrase split by Markdown markup matches as rendered, without markup.
    expect((await instance.search("beta question"))[0].snippet).toEqual({
      before: "已完成：Revised ",
      match: "Beta question",
      after: " with [redacted]",
    });
    expect(await instance.search("hunter2")).toEqual([]);
    expect(await instance.search("weekly")).toEqual([
      { id: first.id, title: "Weekly report", updatedAt: expect.any(String) },
    ]);
    expect(await instance.search("   ")).toEqual([]);
    expect(await instance.search("€25")).toMatchObject([
      { id: priced.id, snippet: { match: "€25" } },
    ]);
    for (const query of ["$12", "今天 很好", String.raw`\frac{a}{b}`])
      expect(await instance.search(query)).toMatchObject([
        { id: priced.id, snippet: { match: query } },
      ]);
  };
  await expectations(service);
  // A fresh service reads the conversation from its session file.
  await expectations(await create());

  // A new message in an open conversation is found by the next search.
  const indexing = vi.spyOn(conversationSearch, "searchableMessages");
  await settle(
    await service.send({
      requestId: randomUUID(),
      conversationId: priced.id,
      text: "Later &euro;7 fee",
      selection,
    }),
  );
  expect(await service.search("€7")).toMatchObject([{ id: priced.id }]);

  // Open conversations keep their index until their branch changes. They are
  // opened from their files, so no run is still writing to them.
  const reader = await create();
  await reader.open(first.id);
  await reader.open(priced.id);
  await reader.search("beta");
  indexing.mockClear();
  await reader.search("beta");
  expect(indexing).not.toHaveBeenCalled();

  // A newer search cancels an older one, which returns nothing.
  const cold = await create();
  const [older, newer] = await Promise.all([
    cold.search("beta"),
    cold.search("beta"),
  ]);
  expect(older).toEqual([]);
  expect(newer).toMatchObject([{ id: first.id }]);

  // Warming up indexes stored conversations before the first search.
  const warmed = await create();
  await warmed.prepareSearch();
  indexing.mockClear();
  expect(await warmed.search("€25")).toMatchObject([{ id: priced.id }]);
  expect(indexing).not.toHaveBeenCalled();

  // A search started during a warm-up is never cancelled by it.
  const warming = await create();
  const preparing = warming.prepareSearch();
  expect(await warming.search("beta")).toMatchObject([{ id: first.id }]);
  await preparing;

  // Cancelling stops a pending search; without warmUp the warm-up goes on
  // and fills the cache, with it the warm-up stops too.
  const clearing = await create();
  const pending = clearing.search("beta");
  const keptWarm = clearing.prepareSearch();
  clearing.cancelSearch(false);
  expect(await pending).toEqual([]);
  await keptWarm;
  indexing.mockClear();
  expect(await clearing.search("beta")).toMatchObject([{ id: first.id }]);
  expect(indexing).not.toHaveBeenCalled();
  const closing = await create();
  const stopped = closing.prepareSearch();
  closing.cancelSearch(true);
  await stopped;
  indexing.mockClear();
  await closing.search("beta");
  expect(indexing).toHaveBeenCalled();

  // Rebuilding an open conversation's index from cached replies still
  // checks in after every message, so a long conversation can't hold the
  // main process.
  let checks = 0;
  indexing.mockImplementation((messages, checkpoint, parsed) =>
    realSearchable(
      messages,
      () => {
        checks++;
        return checkpoint?.();
      },
      parsed,
    ),
  );
  await reader.rename(first.id, "Weekly report, renamed");
  indexing.mockClear();
  await reader.search("beta");
  // Only the renamed conversation is rebuilt, from its cached replies.
  expect(indexing).toHaveBeenCalledTimes(1);
  const [[rebuilt]] = indexing.mock.calls;
  expect(rebuilt.length).toBeGreaterThan(0);
  expect(checks).toBe(rebuilt.length);
});

async function storedSearchFixture(replies: string[]) {
  const root = await mkdtemp(join(tmpdir(), "worklens-search-cache-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const paths = {
    runtime: join(root, "runtime"),
    sessions: join(root, "sessions"),
    userData: join(root, "app"),
  };
  const add = (title: string, messages: string[], timestamp = Date.now()) => {
    const manager = SessionManager.create(root, paths.sessions);
    for (const text of messages) {
      manager.appendMessage({
        role: "user",
        content: "Explain this example",
        timestamp,
      });
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text }],
        api: "openai-completions",
        provider: "worklens-test",
        model: "fixture",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp,
      });
    }
    manager.appendSessionInfo(title);
    return manager.getSessionId();
  };
  const id = add("Stored search fixture", replies);
  const runtime = await ModelRuntime.create({
    modelsPath: null,
    authPath: join(root, "auth.json"),
    allowModelNetwork: false,
  });
  const create = async () => {
    const service = new AgentService(
      runtime,
      paths,
      () => {},
      (text) => text,
    );
    await service.initialize();
    cleanups.push(() => service.shutdown());
    return service;
  };
  return { id, create, add };
}

test("AgentService uses the default source-test worker for a long stored reply", async () => {
  const { id, create } = await storedSearchFixture([
    "A **long** reply with $12 and $24. ".repeat(400),
  ]);
  const service = await create();
  expect(await service.search("$12")).toMatchObject([
    { id, snippet: { match: "$12" } },
  ]);
  await service.open(id);
  expect(await service.search("long reply")).toMatchObject([
    { id, snippet: { match: "long reply" } },
  ]);
});

test("oversized open and stored indexes reuse parsed replies without hiding uncached matches", async () => {
  const replies = Array.from(
    { length: 5 },
    (_, i) => `token-${i} **${"body ".repeat(70)}**`,
  );
  const { id, create } = await storedSearchFixture(replies);
  const parsing = vi.spyOn(searchMarkdown, "parseSearchMarkdown");
  for (const opened of [false, true]) {
    const service = await create();
    const cache = new SearchCache(12000);
    Object.assign(service, { searchCache: cache });
    if (opened) await service.open(id);
    parsing.mockClear();
    expect(await service.search("token-0")).toMatchObject([
      { id, snippet: { match: "token-0" } },
    ]);
    const firstReads = parsing.mock.calls.length;
    const retained = cache.get(id)!;
    expect(retained.messages).toBeUndefined();
    expect(retained.parsed.size).toBeGreaterThan(0);
    if (!opened) expect(retained.source!.length).toBeLessThan(50);
    parsing.mockClear();
    expect(await service.search("token-0")).toMatchObject([{ id }]);
    expect(parsing.mock.calls.length).toBeLessThan(firstReads);
    for (let i = 0; i < replies.length; i++)
      expect(await service.search(`token-${i}`)).toMatchObject([
        { id, snippet: { match: `token-${i}` } },
      ]);
    expect(cache.bytes).toBeLessThanOrEqual(cache.limit);
  }
});

test("mixed small and oversized conversations retain parse reuse across repeated searches", async () => {
  const fixture = await storedSearchFixture(["shared small-one"]);
  const timestamp = Date.now() - 10000;
  const small2 = fixture.add("Small two", ["shared small-two"], timestamp);
  const big = fixture.add(
    "Large fixture",
    Array.from(
      { length: 12 },
      (_, i) => `shared big-${i} **${"body ".repeat(70)}**`,
    ),
    timestamp - 1000,
  );
  const small3 = fixture.add(
    "Small three",
    ["shared small-three"],
    timestamp - 2000,
  );
  const ids = [fixture.id, small2, big, small3];
  const parsing = vi.spyOn(searchMarkdown, "parseSearchMarkdown");
  for (const opened of [false, true]) {
    const service = await fixture.create();
    const cache = new SearchCache(10000);
    Object.assign(service, { searchCache: cache });
    if (opened) for (const id of ids) await service.open(id);
    parsing.mockClear();
    expect((await service.search("shared")).map((item) => item.id)).toEqual(
      ids,
    );
    const firstReads = parsing.mock.calls.length;
    expect(cache.get(big)?.messages).toBeUndefined();
    expect(cache.get(big)?.parsed.size).toBeGreaterThan(0);
    for (const id of [fixture.id, small2, small3])
      expect(cache.get(id)?.messages).toBeDefined();
    for (let round = 0; round < 2; round++) {
      parsing.mockClear();
      expect((await service.search("shared")).map((item) => item.id)).toEqual(
        ids,
      );
      expect(parsing.mock.calls.length).toBeGreaterThan(0);
      expect(parsing.mock.calls.length).toBeLessThan(firstReads);
      expect(
        parsing.mock.calls.every(([text]) => text.startsWith("shared big-")),
      ).toBe(true);
      expect(cache.get(big)?.parsed.size).toBeGreaterThan(0);
      expect(cache.bytes).toBeLessThanOrEqual(cache.limit);
    }
    for (const query of ["big-0", "big-11", "small-one"])
      expect(await service.search(query)).toMatchObject([
        {
          id: query.startsWith("big") ? big : fixture.id,
          snippet: { match: query },
        },
      ]);
  }
});
