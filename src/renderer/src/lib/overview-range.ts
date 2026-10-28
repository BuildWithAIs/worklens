import { addDays, dayKey, startOfDay } from "../../../shared/date-range";
import type { DateRange } from "../../../shared/contracts";

export const RANGE_PRESETS = ["today", "7d", "30d"] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];
export const DEFAULT_RANGE: RangePreset = "7d";
const DAYS: Record<RangePreset, number> = { today: 1, "7d": 7, "30d": 30 };

export interface ResolvedRange extends DateRange {
  previous: DateRange;
}

/**
 * Consecutive local calendar days ending today, so today counts so far. The
 * comparison is the same number of days immediately before.
 */
export function resolveRange(preset: RangePreset, now: Date): ResolvedRange {
  const days = DAYS[preset];
  const end = startOfDay(now);
  const start = addDays(end, -(days - 1));
  return {
    start: dayKey(start),
    end: dayKey(end),
    previous: {
      start: dayKey(addDays(start, -days)),
      end: dayKey(addDays(start, -1)),
    },
  };
}

/** First day of the week for a locale, as a JavaScript weekday. */
export function weekStartFor(locale: string) {
  try {
    const value = new Intl.Locale(locale) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const firstDay = (value.getWeekInfo?.() ?? value.weekInfo)?.firstDay;
    if (firstDay) return firstDay % 7;
  } catch {
    // Unknown locale: fall back to Monday.
  }
  return 1;
}
