import { expect, test } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  estimateToolTokens,
  getCacheSavings,
  readToolTokens,
  withContextSegments,
} from "../src/main/usage";

const text = (length: number) => "x".repeat(length);
const user = (timestamp: number, length = 400) => ({
  role: "user" as const,
  content: text(length),
  timestamp,
});
const assistant = (timestamp: number, length = 800) =>
  ({
    role: "assistant",
    content: [{ type: "text", text: text(length) }],
    timestamp,
  }) as never;
const toolResult = (timestamp: number, length = 1200) =>
  ({
    role: "toolResult",
    toolCallId: `call-${timestamp}`,
    toolName: "read",
    content: [{ type: "text", text: text(length) }],
    isError: false,
    timestamp,
  }) as never;
const summary = (timestamp: number) =>
  ({
    role: "compactionSummary",
    summary: text(2000),
    tokensBefore: 90_000,
    timestamp,
  }) as never;
const known = (tokens: number) => ({
  status: "complete" as const,
  tokens,
  contextWindow: 200_000,
  percent: (tokens / 200_000) * 100,
});
const sum = (segments: { tokens: number }[] = []) =>
  segments.reduce((total, segment) => total + segment.tokens, 0);

const systemPrompt = (length = 8_000) =>
  ({
    role: "system",
    content: "",
    sections: { preamble: text(length) },
  }) as never;

test("segments follow prompt order and are scaled to the reported size", () => {
  const messages = [
    systemPrompt(),
    user(1),
    assistant(2),
    toolResult(3),
    user(4),
    assistant(5),
  ];
  const context = withContextSegments(known(30_000), messages, 5_000, 16_384);
  expect(context.segments?.map((segment) => segment.kind)).toEqual([
    "system",
    "tools",
    "messages",
    "toolResults",
  ]);
  // Rounding may move each segment by at most half a token.
  expect(Math.abs(sum(context.segments) - 30_000)).toBeLessThanOrEqual(2);
  expect(context.compactAt).toBe(200_000 - 16_384);
  expect(context.tokens).toBe(30_000);
});

test("each kind keeps one segment and its ID as the conversation grows", () => {
  const first = withContextSegments(
    known(10_000),
    [user(1), assistant(2)],
    3_000,
    16_384,
  );
  const second = withContextSegments(
    known(14_000),
    [user(1), assistant(2), toolResult(3), user(4), assistant(5)],
    3_000,
    16_384,
  );
  expect(first.segments?.map((segment) => segment.id)).toEqual([
    "tools",
    "messages",
  ]);
  expect(second.segments?.map((segment) => segment.id)).toEqual([
    "tools",
    "messages",
    "toolResults",
  ]);
});

test("command output the user ran counts as a tool result", () => {
  const command = {
    role: "bashExecution",
    command: "ls",
    output: text(4_000),
    exitCode: 0,
    cancelled: false,
    truncated: false,
    timestamp: 2,
  } as never;
  const context = withContextSegments(
    { status: "unavailable", contextWindow: 200_000 },
    [user(1), command],
    500,
    16_384,
  );
  expect(context.segments?.map((segment) => segment.kind)).toEqual([
    "tools",
    "messages",
    "toolResults",
  ]);
});

test("after compaction the summary follows the system prompt and tools", () => {
  const context = withContextSegments(
    known(20_000),
    [systemPrompt(), summary(10), assistant(11), user(12), assistant(13)],
    4_000,
    16_384,
  );
  expect(context.segments?.map((segment) => segment.kind)).toEqual([
    "system",
    "tools",
    "summary",
    "messages",
  ]);
});

test("an unknown size stays unknown while segments carry an estimate", () => {
  const context = withContextSegments(
    { status: "unavailable", contextWindow: 200_000 },
    [summary(10)],
    4_000,
    16_384,
  );
  expect(context.status).toBe("unavailable");
  expect(context.tokens).toBeUndefined();
  expect(context.segments?.[0]).toEqual({
    id: "tools",
    kind: "tools",
    tokens: 4_000,
  });
  expect(context.segments?.[1].kind).toBe("summary");
});

test("without a recorded system size, it is the reported remainder", () => {
  const messages = [user(1, 4_000)];
  const context = withContextSegments(known(5_000), messages, undefined, 0);
  expect(context.segments?.[0].kind).toBe("system");
  expect(sum(context.segments)).toBe(5_000);
  // Nothing can be drawn when neither the size nor the system part is known.
  expect(
    withContextSegments(
      { status: "unavailable", contextWindow: 200_000 },
      messages,
      undefined,
      0,
    ).segments,
  ).toBeUndefined();
});

test("the compaction threshold needs a window larger than the reserve", () => {
  expect(
    withContextSegments(
      { ...known(1_000), contextWindow: 10_000 },
      [],
      100,
      16_384,
    ).compactAt,
  ).toBeUndefined();
  expect(
    withContextSegments({ status: "unavailable" }, [], 100, 16_384).compactAt,
  ).toBeUndefined();
});

test("tool size counts only tools that are sent to the model", () => {
  const tool = (exposure?: string) => ({
    exposure,
    name: "tool",
    description: text(396),
  });
  expect(estimateToolTokens([])).toBe(0);
  const one = estimateToolTokens([tool()]);
  expect(one).toBeGreaterThan(100);
  expect(estimateToolTokens([tool(), tool("direct")])).toBeGreaterThan(
    one * 1.9,
  );
  expect(
    estimateToolTokens([tool("deferred"), tool("codemode"), tool("hidden")]),
  ).toBe(0);
});

test("system messages form the system segment, apart from tool definitions", () => {
  const context = withContextSegments(
    { status: "unavailable", contextWindow: 200_000 },
    [systemPrompt(), user(1), assistant(2)],
    500,
    16_384,
  );
  expect(context.segments?.map((segment) => segment.kind)).toEqual([
    "system",
    "tools",
    "messages",
  ]);
  // About 2,000 tokens of system prompt; the tools are counted separately.
  expect(context.segments?.[0].tokens).toBeGreaterThan(1_900);
  expect(context.segments?.[1].tokens).toBe(500);
});

test("tool declarations in system messages count once, as tools", () => {
  const declaring = {
    role: "system",
    content: "",
    sections: { preamble: text(8_000) },
    toolsAdded: [{ name: "read", description: text(4_000) }],
  } as never;
  const segments = (toolTokens?: number) =>
    withContextSegments(
      { status: "unavailable", contextWindow: 200_000 },
      [declaring, user(1)],
      toolTokens,
      16_384,
    ).segments!;
  // The recorded size of the tools sent replaces the declarations.
  const recorded = segments(300);
  expect(recorded[0]).toMatchObject({ kind: "system", tokens: 2_000 });
  expect(recorded[1]).toMatchObject({ kind: "tools", tokens: 300 });
  // Without it, the declarations themselves are the tool size.
  expect(segments()[1].kind).toBe("tools");
  expect(segments()[1].tokens).toBeGreaterThan(1_000);
});

test("cache savings price reads at the uncached input rate", () => {
  const entry = (provider: string, cacheRead?: number) =>
    ({
      type: "message",
      message: {
        role: "assistant",
        provider,
        model: "m",
        usage: { input: 10, output: 5, cacheRead, cacheWrite: 0 },
      },
    }) as unknown as SessionEntry;
  const lookup = (provider: string) =>
    provider === "priced"
      ? { cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } }
      : undefined;
  expect(
    getCacheSavings(
      [entry("priced", 1_000_000), entry("unknown", 5_000_000)],
      lookup,
    ),
  ).toBeCloseTo(2.7);
  expect(getCacheSavings([entry("unknown", 1_000)], lookup)).toBeUndefined();
  expect(getCacheSavings([entry("priced", 0)], lookup)).toBeUndefined();
});

test("the latest recorded run provides the tool size", () => {
  const start = (toolTokens?: number) =>
    ({
      type: "custom",
      customType: "worklens.run-start",
      data: { version: 1, toolTokens },
    }) as unknown as SessionEntry;
  expect(readToolTokens([start(100), start(250)])).toBe(250);
  expect(readToolTokens([start(100), start()])).toBe(100);
  expect(readToolTokens([])).toBeUndefined();
});
