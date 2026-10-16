import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AgentService } from "../src/main/agent-service";
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

test("folds case without moving offsets", () => {
  expect(foldSearchText("Hello 搓手指 İ")).toHaveLength(
    "Hello 搓手指 İ".length,
  );
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
      text: "Costs &euro;25 per month",
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
