import { test, expect } from "vitest";
import { formatTokens, formatCost } from "../src/renderer/src/lib/usage-format";
test("compact tokens and estimated cost distinguish unknown, zero and sub-cent values", () => {
  expect([823, 8231, 44120, 3860000].map(formatTokens)).toEqual([
    "823",
    "8.2k",
    "44.1k",
    "3.86M",
  ]);
  expect(formatTokens(0)).toBe("0");
  for (const value of [undefined, NaN, Infinity, -1]) {
    expect(formatTokens(value)).toBe("—");
    expect(formatCost(value)).toBe("—");
  }
  expect(formatCost(0)).toBe("$0.00");
  expect(formatCost(0.003)).toBe("$0.003");
  expect(formatCost(0.0001)).toBe("<$0.001");
  // Detailed costs keep three decimals below $1 and use cents above it.
  expect(formatCost(0.184, true)).toBe("$0.184");
  expect(formatCost(48.513, true)).toBe("$48.51");
  expect(formatCost(84.867, true)).toBe("$84.87");
});
