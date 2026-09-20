import { expect, test } from "vitest";
import { countNewItems } from "../src/renderer/src/lib/count-new-items";

test("counts new identities, not net growth, state changes, order or duplicates", () => {
  const before = [
    { id: "a", enabled: false },
    { id: "removed", enabled: true },
  ];
  const after = [
    { id: "new", enabled: false },
    { id: "a", enabled: true },
    { id: "new", enabled: false },
  ];
  expect(countNewItems(before, after)).toBe(1);
  expect(countNewItems(after, [...after].reverse())).toBe(0);
  expect(countNewItems([], after)).toBe(2);
  expect(countNewItems(before, [])).toBe(0);
  expect(countNewItems(undefined, after)).toBe(0);
});
