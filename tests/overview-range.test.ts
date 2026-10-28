import { describe, expect, test } from "vitest";
import {
  resolveRange,
  weekStartFor,
} from "../src/renderer/src/lib/overview-range";
import {
  formatAgo,
  formatShare,
  niceTicks,
} from "../src/renderer/src/lib/overview-format";

// Monday 26 October 2026, mid-afternoon.
const now = new Date(2026, 9, 26, 15, 30);

describe("overview date ranges", () => {
  test("ranges are consecutive local days ending today, compared with the days before", () => {
    expect(resolveRange("today", now)).toEqual({
      start: "2026-10-26",
      end: "2026-10-26",
      previous: { start: "2026-10-25", end: "2026-10-25" },
    });
    expect(resolveRange("7d", now)).toEqual({
      start: "2026-10-20",
      end: "2026-10-26",
      previous: { start: "2026-10-13", end: "2026-10-19" },
    });
    expect(resolveRange("30d", now)).toEqual({
      start: "2026-09-27",
      end: "2026-10-26",
      previous: { start: "2026-08-28", end: "2026-09-26" },
    });
  });

  test("ranges cross month and year boundaries by calendar day", () => {
    expect(resolveRange("7d", new Date(2026, 0, 3))).toEqual({
      start: "2025-12-28",
      end: "2026-01-03",
      previous: { start: "2025-12-21", end: "2025-12-27" },
    });
  });

  test("the first weekday comes from the locale", () => {
    expect(weekStartFor("zh-CN")).toBe(1);
    expect(weekStartFor("en-GB")).toBe(1);
    expect(weekStartFor("en-US")).toBe(0);
    expect(weekStartFor("not a locale")).toBe(1);
  });
});

describe("overview shares", () => {
  test("small nonzero shares read as under 1% instead of 0%", () => {
    expect(formatShare(0.006, "en")).toBe("<1%");
    expect(formatShare(0, "en")).toBe("0%");
    expect(formatShare(0.01, "en")).toBe("1%");
    expect(formatShare(0.564, "en")).toBe("56%");
  });
});

describe("overview last activity", () => {
  const now = new Date(2026, 9, 27, 15, 0);
  const at = (y: number, m: number, d: number, h = 0, min = 0, sec = 0) =>
    new Date(y, m, d, h, min, sec).toISOString();
  test("reads relative to now, in the largest whole unit", () => {
    expect(formatAgo(at(2026, 9, 27, 14, 55), now, "en")).toBe("5 min. ago");
    expect(formatAgo(at(2026, 9, 27, 14, 59, 50), now, "en")).toBe(
      "1 min. ago",
    );
    expect(formatAgo(at(2026, 9, 27, 9, 0), now, "en")).toBe("6 hr. ago");
    // Calendar days, so late last night is yesterday.
    expect(formatAgo(at(2026, 9, 26, 23, 50), now, "en")).toBe("yesterday");
    expect(formatAgo(at(2026, 9, 23), now, "en")).toBe("4 days ago");
    expect(formatAgo(at(2026, 9, 13), now, "en")).toBe("2 wk. ago");
    expect(formatAgo(at(2026, 6, 1), now, "en")).toBe("3 mo. ago");
    expect(formatAgo(at(2024, 9, 1), now, "en")).toBe("2 yr. ago");
    expect(formatAgo(at(2026, 9, 23), now, "zh-CN")).toBe("4天前");
  });
});

describe("overview axis ticks", () => {
  test("token counts never get fractional ticks", () => {
    // A quiet range scales to 1; fractional steps rounded to 0, 0, 1, 1, 1.
    expect(niceTicks(1)).toEqual([0, 1]);
    expect(niceTicks(3)).toEqual([0, 1, 2, 3]);
    expect(niceTicks(0)).toEqual([0, 1]);
  });

  test("larger ranges keep round steps", () => {
    expect(niceTicks(120_000_000)).toEqual([
      0, 50_000_000, 100_000_000, 150_000_000,
    ]);
    // 2.5 would label 3 and 8 once rounded to whole tokens.
    expect(niceTicks(10)).toEqual([0, 5, 10]);
  });
});
