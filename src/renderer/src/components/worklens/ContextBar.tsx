import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useAppTranslation } from "@/i18n";
import { formatTokens } from "@/lib/usage-format";
import { nonNegative } from "../../../../shared/usage";
import type {
  ContextSegment,
  ContextUsage,
} from "../../../../shared/contracts";

/** Exit transitions keep removed segments briefly at zero width. */
const EXIT_MS = 600;
type Rendered = ContextSegment & { exiting?: boolean };

function reducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** Keeps segments that disappeared, in place, until they finish shrinking. */
function usePresence(segments: ContextSegment[]): Rendered[] {
  const key = segments.map((segment) => segment.id).join("|");
  const [rendered, setRendered] = useState<Rendered[]>(segments);
  const previous = useRef<Rendered[]>(segments);
  useEffect(() => {
    const ids = new Set(segments.map((segment) => segment.id));
    const leaving = previous.current.filter(
      (segment) => !segment.exiting && !ids.has(segment.id),
    );
    previous.current = segments;
    if (!leaving.length || reducedMotion()) {
      setRendered(segments);
      return;
    }
    // Leaving segments keep their position after the last surviving segment
    // that preceded them, so the bar collapses towards its start.
    const merged: Rendered[] = [];
    const remaining = [...segments];
    let leaveIndex = 0;
    for (const segment of rendered) {
      if (ids.has(segment.id)) {
        while (remaining.length && remaining[0].id !== segment.id)
          merged.push(remaining.shift()!);
        if (remaining.length) merged.push(remaining.shift()!);
      } else if (leaving[leaveIndex]?.id === segment.id) {
        merged.push({ ...leaving[leaveIndex++], exiting: true });
      }
    }
    merged.push(...remaining);
    setRendered(merged);
    const timer = setTimeout(() => setRendered(segments), EXIT_MS);
    return () => clearTimeout(timer);
    // Membership is fully described by the IDs; sizes come from `segments`.
  }, [key]);
  // Sizes of surviving segments follow the latest values immediately.
  const sizes = new Map(segments.map((segment) => [segment.id, segment]));
  return rendered.map((segment) => sizes.get(segment.id) ?? segment);
}

/** Tweens a number towards its latest value. */
export function useAnimatedNumber(value: number | undefined, duration = 500) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    if (!nonNegative(value) || !nonNegative(from.current) || reducedMotion()) {
      from.current = value;
      setShown(value);
      return;
    }
    const start = from.current;
    const began = performance.now();
    let frame = requestAnimationFrame(function step(now) {
      const progress = Math.min(1, (now - began) / duration);
      const eased = 1 - (1 - progress) ** 3;
      const next = start + (value - start) * eased;
      from.current = next;
      setShown(next);
      if (progress < 1) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [value, duration]);
  return shown;
}

/** Narrow history turns merge into the block before them (keeping its ID). */
function legible(segments: ContextSegment[], window: number, minimum: number) {
  const result: ContextSegment[] = [];
  for (const segment of segments) {
    const previous = result.at(-1);
    const narrow = (segment.tokens / window) * 100 < minimum;
    if (
      segment.kind === "history" &&
      previous?.kind === "history" &&
      (narrow || (previous.tokens / window) * 100 < minimum)
    )
      result[result.length - 1] = {
        ...previous,
        tokens: previous.tokens + segment.tokens,
      };
    else result.push(segment);
  }
  return result;
}

export function contextTotals(context?: ContextUsage) {
  const window = context?.contextWindow;
  const segments = context?.segments ?? [];
  const estimated =
    !nonNegative(context?.tokens) && segments.length > 0 && nonNegative(window);
  const tokens = nonNegative(context?.tokens)
    ? context.tokens
    : estimated
      ? segments.reduce((sum, segment) => sum + segment.tokens, 0)
      : undefined;
  const percent =
    nonNegative(tokens) && nonNegative(window) && window > 0
      ? (tokens / window) * 100
      : undefined;
  const near =
    nonNegative(tokens) &&
    nonNegative(context?.compactAt) &&
    tokens >= context.compactAt * 0.9;
  return { tokens, percent, estimated, near, window };
}

/** A highlighted category, shared by a bar and its legend. */
export interface Highlight {
  active?: string;
  onActive?: (kind?: string) => void;
}
const highlight = (kind: string, { active, onActive }: Highlight) => ({
  "data-dim": (active && active !== kind) || undefined,
  onMouseEnter: onActive && (() => onActive(kind)),
  onMouseLeave: onActive && (() => onActive(undefined)),
});

/** One row of proportional segments; the same marks in every usage bar. */
export function SegmentTrack({
  segments,
  className,
  ...state
}: {
  segments: {
    id: string;
    kind: string;
    percent: number;
    exiting?: boolean;
  }[];
  className?: string;
} & Highlight) {
  return (
    <div
      className={["usage-context-track", className].filter(Boolean).join(" ")}
    >
      {segments.map((segment, index) => (
        <span
          key={segment.id}
          data-segment={segment.id}
          data-kind={segment.kind}
          data-exiting={segment.exiting || undefined}
          {...highlight(segment.kind, state)}
          style={
            {
              "--width": segment.exiting ? "0%" : `${segment.percent}%`,
              "--index": index,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}

/** Legend for a SegmentTrack; hovering an entry highlights its segments. */
export function UsageLegend({
  items,
  marker,
  ...state
}: {
  items: { kind: string; label: string; description: string; value: string }[];
  /** A dashed threshold line drawn on the bar, explained with its value. */
  marker?: { label: string; value: string };
} & Highlight) {
  return (
    <ul className="usage-legend">
      {items.map(({ kind, label, description, value }) => (
        <li
          key={kind}
          data-legend={kind}
          aria-label={`${description} ${value}`}
          {...highlight(kind, state)}
        >
          <i data-kind={kind} aria-hidden="true" />
          {label}
          <strong>{value}</strong>
        </li>
      ))}
      {marker && (
        <li data-legend="marker" aria-label={`${marker.label} ${marker.value}`}>
          <i data-marker aria-hidden="true" />
          {marker.label}
          <strong>{marker.value}</strong>
        </li>
      )}
    </ul>
  );
}

export function ContextBar({
  context,
  compacting,
  size,
  ...state
}: {
  context?: ContextUsage;
  compacting: boolean;
  size: "mini" | "full";
} & Highlight) {
  const { t } = useAppTranslation();
  const window = context?.contextWindow;
  const known = nonNegative(window) && window > 0;
  const segments = usePresence(
    known
      ? legible(context?.segments ?? [], window, size === "full" ? 1.2 : 3)
      : [],
  );
  const { tokens, percent, estimated } = contextTotals(context);
  const label = known
    ? (context?.segments ?? [])
        .map(
          (segment) =>
            `${t(`usage.segments.${segment.kind}`)} ${formatTokens(segment.tokens)}`,
        )
        .join(", ") || `${formatTokens(tokens)} / ${formatTokens(window)}`
    : t("usage.unavailable");
  const valueText = estimated
    ? `${label} · ${t("usage.estimatedUntilReply")}`
    : label;
  const threshold =
    known && nonNegative(context?.compactAt)
      ? Math.min(100, (context.compactAt / window) * 100)
      : undefined;
  return (
    <div
      className="usage-context-bar"
      data-size={size}
      data-slot={size === "mini" ? "usage-icon" : undefined}
      data-compacting={compacting || undefined}
      data-estimated={estimated || undefined}
      // The header text already announces the mini bar's value.
      aria-hidden={size === "mini" || undefined}
      {...(size === "full" && nonNegative(percent)
        ? {
            role: "progressbar",
            "aria-label": t("usage.contextUsage"),
            "aria-valuemin": 0,
            "aria-valuemax": 100,
            "aria-valuenow": Math.min(100, percent),
            "aria-valuetext": valueText,
          }
        : {})}
    >
      <SegmentTrack
        segments={segments.map((segment) => ({
          ...segment,
          percent: (segment.tokens / window!) * 100,
        }))}
        {...(size === "full" ? state : {})}
      />
      {/* The legend names the threshold and its value; the mini bar omits it. */}
      {threshold !== undefined && size === "full" && (
        <span
          className="usage-context-threshold"
          style={{ "--at": `${threshold}%` } as CSSProperties}
        />
      )}
    </div>
  );
}
