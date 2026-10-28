// Local calendar dates as YYYY-MM-DD. Arithmetic goes through the Date
// constructor so daylight saving changes never shift a day boundary.
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad = (value: number) => String(value).padStart(2, "0");

export function dayKey(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function parseDay(key: string): Date | undefined {
  const match = DAY_PATTERN.exec(key);
  if (!match) return undefined;
  const date = new Date(+match[1], +match[2] - 1, +match[3]);
  return dayKey(date) === key ? date : undefined;
}

export function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function addDays(date: Date, days: number) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

export function daysBetween(from: Date, to: Date) {
  return Math.round(
    (startOfDay(to).getTime() - startOfDay(from).getTime()) / 864e5,
  );
}

export type Granularity = "day" | "week" | "month";

/** Trend buckets stay readable: daily up to a month, weekly up to half a year. */
export function granularityFor(days: number): Granularity {
  return days <= 31 ? "day" : days <= 182 ? "week" : "month";
}

/** Buckets covering start..end inclusive; each `end` is exclusive. */
export function periodBuckets(
  start: Date,
  end: Date,
  granularity: Granularity,
  weekStart: number,
): { start: Date; end: Date }[] {
  const buckets: { start: Date; end: Date }[] = [];
  const last = addDays(end, 1);
  let current = startOfDay(start);
  while (current < last) {
    let next =
      granularity === "day"
        ? addDays(current, 1)
        : granularity === "week"
          ? addDays(current, 7 - ((current.getDay() - weekStart + 7) % 7))
          : new Date(current.getFullYear(), current.getMonth() + 1, 1);
    if (next > last) next = last;
    buckets.push({ start: current, end: next });
    current = next;
  }
  return buckets;
}
