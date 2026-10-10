import { expect, test } from "vitest";
import { formatDuration } from "../src/renderer/src/lib/duration";

test("long work reads as minutes and hours instead of hundreds of seconds", () => {
  const en = (ms: number) => formatDuration(ms, "en");
  expect(en(47_000)).toBe("47s");
  expect(en(274_700)).toBe("4m 34s");
  expect(en(3_725_000)).toBe("1h 2m");
  expect(formatDuration(274_700, "zh")).toBe("4分34秒");
  expect(formatDuration(3_725_000, "zh")).toBe("1小时2分");
  expect(formatDuration(47_000, "zh")).toBe("47秒");
});

test("precise durations keep tenths for short tool calls", () => {
  expect(formatDuration(400, "en", true)).toBe("<1s");
  expect(formatDuration(2_840, "en", true)).toBe("2.8s");
  expect(formatDuration(12_900, "en", true)).toBe("12s");
  expect(formatDuration(2_840, "zh", true)).toBe("2.8秒");
  // A ticking counter shows whole seconds.
  expect(formatDuration(7_000, "en")).toBe("7s");
});
