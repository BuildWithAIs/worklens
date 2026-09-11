import { test, expect } from "vitest";
import {
  newerGlobalUsage,
  nonNegative,
  unavailableUsage,
} from "../src/shared/usage";
import type { GlobalUsage, TokenUsage } from "../src/shared/contracts";

test("known zero, missing usage and independently partial cost stay distinct", () => {
  const unknown = unavailableUsage();
  expect(unknown).not.toHaveProperty("total");
  expect(unknown.cost).not.toHaveProperty("usd");
  const known: TokenUsage = {
    status: "complete",
    total: 0,
    cost: { status: "complete", usd: 0, source: "pi-estimate" },
  };
  const partial: TokenUsage = {
    status: "complete",
    total: 140,
    cost: { status: "partial", usd: 0.02, source: "pi-estimate" },
  };
  expect(known.total).toBe(0);
  expect(partial.status).not.toBe(partial.cost.status);
  for (const value of [NaN, Infinity, -1, null, undefined, "2"])
    expect(nonNegative(value)).toBe(false);
  expect(nonNegative(0)).toBe(true);
});
test("global merge ignores older bootstrap and accepts partial/unavailable newer states", () => {
  const state: GlobalUsage = {
    status: "complete",
    totalTokens: 20,
    scope: "retained-local-sessions",
    sessionCount: 2,
    readableSessionCount: 2,
    unavailableSessionCount: 0,
    revision: 5,
  };
  expect(
    newerGlobalUsage(state, { ...state, revision: 4, totalTokens: 100 }),
  ).toBe(state);
  expect(
    newerGlobalUsage(state, {
      ...state,
      revision: 6,
      status: "partial",
      totalTokens: 10,
    })?.status,
  ).toBe("partial");
  expect(
    newerGlobalUsage(state, {
      ...state,
      revision: 7,
      status: "unavailable",
      totalTokens: undefined,
    })?.totalTokens,
  ).toBeUndefined();
});
