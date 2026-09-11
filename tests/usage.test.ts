import { test, expect } from "vitest";
import {
  aggregateUsage,
  buildContextUsage,
  getConversationUsage,
  normalizeTokenUsage,
  subtractUsage,
  UsageService,
} from "../src/main/usage";
import { unavailableUsage } from "../src/shared/usage";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
const raw = {
  input: 80,
  output: 40,
  cacheRead: 20,
  cacheWrite: 0,
  totalTokens: 140,
  reasoning: 10,
  cost: { total: 0.04 },
};
const normal = () => normalizeTokenUsage(raw);
test("Pi buckets and reasoning metadata are normalized without double counting", () => {
  expect(normal()).toMatchObject({
    status: "complete",
    total: 140,
    reasoning: 10,
    cost: { status: "complete", usd: 0.04, source: "pi-estimate" },
  });
  expect(
    normalizeTokenUsage({ ...raw, input: NaN, totalTokens: 140 }).status,
  ).toBe("partial");
  expect(
    normalizeTokenUsage({ ...raw, input: Infinity, totalTokens: Infinity })
      .status,
  ).toBe("unavailable");
  expect(normalizeTokenUsage({ ...raw, cost: { total: 0 } }).cost.status).toBe(
    "unavailable",
  );
  expect(
    normalizeTokenUsage({ ...raw, cost: undefined }).cost,
  ).not.toHaveProperty("usd");
});
test("empty history is known zero; missing requests and missing prices are independent", () => {
  expect(aggregateUsage([])).toMatchObject({ status: "complete", total: 0 });
  expect(aggregateUsage([normal(), unavailableUsage()])).toMatchObject({
    status: "partial",
    total: 140,
    cost: { status: "partial" },
  });
  expect(
    aggregateUsage([
      normal(),
      normalizeTokenUsage({ ...raw, cost: undefined }),
    ]),
  ).toMatchObject({
    status: "complete",
    total: 280,
    cost: { status: "partial", usd: 0.04 },
  });
  expect(aggregateUsage([unavailableUsage()])).toEqual(unavailableUsage());
});
test("run delta refuses incomparable snapshots and supports fresh entry coverage", () => {
  expect(
    subtractUsage(aggregateUsage([normal(), normal()]), normal()),
  ).toMatchObject({ total: 140, cost: { usd: 0.04 } });
  expect(
    subtractUsage(normal(), aggregateUsage([normal(), normal()])).status,
  ).toBe("unavailable");
  expect(subtractUsage(normal(), unavailableUsage()).status).toBe(
    "unavailable",
  );
  expect(
    subtractUsage(
      aggregateUsage([normal(), normal()]),
      unavailableUsage(),
      normal(),
    ),
  ).toEqual(normal());
});
test("summary and tool usage count but run-end checkpoint never adds consumption", () => {
  const entries = [
    { type: "message", message: { role: "assistant", usage: raw } },
    { type: "message", message: { role: "toolResult", usage: raw } },
    { type: "compaction", usage: raw },
    { type: "branch_summary", usage: raw },
    {
      type: "custom",
      customType: "worklens.run-end",
      data: { usage: normal() },
    },
  ] as unknown as SessionEntry[];
  expect(getConversationUsage(entries).total).toBe(560);
});
test("context unknown after compaction stays unknown; invalid window is omitted", () => {
  expect(
    buildContextUsage({ tokens: null, percent: null, contextWindow: 200000 }),
  ).toEqual({ status: "unavailable", contextWindow: 200000 });
  expect(
    buildContextUsage({ tokens: 68000, percent: 34, contextWindow: 200000 }),
  ).toMatchObject({ status: "complete", percent: 34 });
  expect(
    buildContextUsage({ tokens: -1, percent: -1, contextWindow: 0 }),
  ).toEqual({ status: "unavailable" });
});
test("global cache deduplicates reopen, reports partial reads and ignores in-flight stale rebuild", async () => {
  const service = new UsageService();
  expect(service.getGlobalUsage()).toMatchObject({
    status: "complete",
    totalTokens: 0,
  });
  service.update("a", normal());
  const initial = service.getGlobalUsage();
  service.update("a", normal());
  expect(service.getGlobalUsage()).toEqual(initial);
  let finish!: (value: Map<string, ReturnType<typeof normal>>) => void;
  const pending = service.rebuild(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  service.update("b", normal());
  finish(new Map([["a", normal()]]));
  expect(await pending).toBe(false);
  expect(service.getGlobalUsage().totalTokens).toBe(280);
  service.update("bad", unavailableUsage());
  expect(service.getGlobalUsage()).toMatchObject({
    status: "partial",
    totalTokens: 280,
    unavailableSessionCount: 1,
  });
  service.remove("a");
  expect(service.getGlobalUsage().totalTokens).toBe(140);
  expect(service.getGlobalUsage().revision).toBeGreaterThan(initial.revision);
});

test("reported estimated cost survives missing token accounting independently", () => {
  expect(normalizeTokenUsage({ cost: { total: 0.02 } })).toEqual({
    status: "unavailable",
    cost: { status: "complete", usd: 0.02, source: "pi-estimate" },
  });
});
