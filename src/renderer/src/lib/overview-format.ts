import { addDays, parseDay } from "../../../shared/date-range";

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(locale: string, options: Intl.DateTimeFormatOptions) {
  const key = `${locale}|${JSON.stringify(options)}`;
  let value = formatters.get(key);
  if (!value)
    formatters.set(key, (value = new Intl.DateTimeFormat(locale, options)));
  return value;
}
const dayOptions = (date: Date, other = date): Intl.DateTimeFormatOptions => {
  const year = new Date().getFullYear();
  return {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() !== year || other.getFullYear() !== year
      ? { year: "numeric" }
      : {}),
  };
};

/** "Oct 13 – 19" or "10月13日至19日"; a single day when start equals end. */
export function formatDayRange(start: string, end: string, locale: string) {
  const from = parseDay(start)!;
  const to = parseDay(end)!;
  const format = formatter(locale, dayOptions(from, to));
  return start === end ? format.format(from) : format.formatRange(from, to);
}

export function formatDay(key: string, locale: string) {
  const date = parseDay(key)!;
  return formatter(locale, dayOptions(date)).format(date);
}

/** Compact axis label: "10/26", or the month name for monthly buckets. */
export function formatAxisDay(
  key: string,
  locale: string,
  granularity: "day" | "week" | "month",
) {
  const date = parseDay(key)!;
  return formatter(
    locale,
    granularity === "month"
      ? { month: "short" }
      : { month: "numeric", day: "numeric" },
  ).format(date);
}

/** Short weekday name for a JavaScript weekday (0 = Sunday). */
export function weekdayName(day: number, locale: string) {
  // 2023-01-01 was a Sunday.
  return formatter(locale, { weekday: "short" }).format(
    addDays(new Date(2023, 0, 1), day),
  );
}

export function hourLabel(hour: number, locale: string) {
  return formatter(locale, { hour: "numeric" }).format(
    new Date(2023, 0, 1, hour),
  );
}

export function formatPercent(value: number, locale: string) {
  return new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(value);
}

/** A share of a whole; small but nonzero shares read "<1%", not "0%". */
export function formatShare(value: number, locale: string) {
  return value > 0 && value < 0.01
    ? `<${formatPercent(0.01, locale)}`
    : formatPercent(value, locale);
}

/** Last activity: time today, weekday this week, otherwise the date. */
export function formatLastActive(iso: string, now: Date, locale: string) {
  const date = new Date(iso);
  const days = Math.round(
    (new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() -
      new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) /
      864e5,
  );
  if (days === 0)
    return formatter(locale, { hour: "numeric", minute: "2-digit" }).format(
      date,
    );
  if (days < 7)
    return formatter(locale, {
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  return formatter(locale, dayOptions(date)).format(date);
}

/** Last activity relative to now: "5 min. ago", "yesterday", "2 mo. ago". */
export function formatAgo(iso: string, now: Date, locale: string) {
  const date = new Date(iso);
  const format = new Intl.RelativeTimeFormat(locale, {
    numeric: "auto",
    style: "short",
  });
  const days = Math.round(
    (new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() -
      new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) /
      864e5,
  );
  if (days <= 0) {
    const minutes = Math.max(
      1,
      Math.floor((now.getTime() - date.getTime()) / 6e4),
    );
    return minutes < 60
      ? format.format(-minutes, "minute")
      : format.format(-Math.floor(minutes / 60), "hour");
  }
  if (days < 7) return format.format(-days, "day");
  if (days < 30) return format.format(-Math.floor(days / 7), "week");
  if (days < 365) return format.format(-Math.floor(days / 30), "month");
  return format.format(-Math.floor(days / 365), "year");
}

/**
 * Evenly spaced axis ticks from 0 that cover max with a round step. Tokens
 * are whole, so the step is too: a fractional one would print rounded,
 * repeated or wrong labels.
 */
export function niceTicks(max: number, count = 4) {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normal = raw / magnitude;
  const nice =
    (normal <= 1
      ? 1
      : normal <= 2
        ? 2
        : normal <= 2.5
          ? 2.5
          : normal <= 5
            ? 5
            : 10) * magnitude;
  const step = nice < 1 ? 1 : Number.isInteger(nice) ? nice : 5 * magnitude;
  const ticks: number[] = [];
  for (
    let value = 0;
    value <= Math.ceil(max / step) * step + step / 2;
    value += step
  )
    ticks.push(value);
  return ticks;
}
