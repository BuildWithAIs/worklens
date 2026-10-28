import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  BookOpen,
  Ellipsis,
  GitPullRequest,
  Tag,
  Ticket,
  type LucideIcon,
} from "lucide-react";
import { OverflowHint } from "@/components/ui/tooltip";
import { TokenCount } from "./OverviewTable";
import { useAppTranslation } from "@/i18n";
import { formatTokens } from "@/lib/usage-format";
import {
  formatAxisDay,
  formatDayRange,
  formatPercent,
  hourLabel,
  niceTicks,
  weekdayName,
} from "@/lib/overview-format";
import { nonNegative } from "../../../../../shared/usage";
import type {
  Overview,
  OverviewConversation,
  OverviewTopic,
  OverviewTopicSource,
  TokenUsage,
} from "../../../../../shared/contracts";

export const VIZ = [
  "var(--overview-viz-1)",
  "var(--overview-viz-2)",
  "var(--overview-viz-3)",
  "var(--overview-viz-4)",
];
export const TOPIC_ICONS: Record<OverviewTopicSource, LucideIcon> = {
  jira: Ticket,
  github: GitPullRequest,
  confluence: BookOpen,
  keyword: Tag,
  other: Ellipsis,
};
type Translate = ReturnType<typeof useAppTranslation>["t"];

export function useElementWidth<T extends HTMLElement>(): [
  RefObject<T | null>,
  number,
] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.floor(entry.contentRect.width)),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** One pointer tooltip per chart; marks are also described in table views. */
export function useTooltip() {
  const [tip, setTip] = useState<{
    content: ReactNode;
    x: number;
    y: number;
  }>();
  const show = useCallback(
    (content: ReactNode, event: MouseEvent) =>
      setTip({ content, x: event.clientX, y: event.clientY }),
    [],
  );
  const hide = useCallback(() => setTip(undefined), []);
  useEffect(() => {
    if (!tip) return;
    const escape = (event: KeyboardEvent) => event.key === "Escape" && hide();
    window.addEventListener("keydown", escape);
    window.addEventListener("scroll", hide, true);
    return () => {
      window.removeEventListener("keydown", escape);
      window.removeEventListener("scroll", hide, true);
    };
  }, [tip, hide]);
  const element = tip ? (
    <div
      className="overview-tooltip"
      role="tooltip"
      style={{
        left: Math.max(150, Math.min(tip.x, window.innerWidth - 150)),
        top: tip.y - 12,
        transform: `translate(-50%, ${tip.y < 120 ? "28px" : "-100%"})`,
      }}
    >
      {tip.content}
    </div>
  ) : null;
  return { element, show, hide };
}

/** Known tokens, or a state label when the usage is partial or unknown. */
export function UsageValue({ usage, t }: { usage: TokenUsage; t: Translate }) {
  if (!nonNegative(usage.total))
    return <span data-muted>{t("overview.unavailable")}</span>;
  return (
    <>
      {formatTokens(usage.total)}
      {usage.status === "partial" && (
        <span data-muted> · {t("overview.partialData")}</span>
      )}
    </>
  );
}

/**
 * A monotone cubic curve through the points (Fritsch–Carlson), so the line
 * is soft at each day but never overshoots between them.
 */
function smoothPath(points: [number, number][]) {
  const n = points.length;
  if (n < 2) return "";
  const slopes: number[] = [];
  for (let i = 0; i < n - 1; i++)
    slopes.push(
      (points[i + 1][1] - points[i][1]) / (points[i + 1][0] - points[i][0]),
    );
  const tangents = points.map((_, i) =>
    i === 0
      ? slopes[0]
      : i === n - 1
        ? slopes[n - 2]
        : slopes[i - 1] * slopes[i] <= 0
          ? 0
          : (slopes[i - 1] + slopes[i]) / 2,
  );
  for (let i = 0; i < n - 1; i++) {
    if (slopes[i] === 0) {
      tangents[i] = tangents[i + 1] = 0;
      continue;
    }
    const a = tangents[i] / slopes[i];
    const b = tangents[i + 1] / slopes[i];
    const h = a * a + b * b;
    if (h > 9) {
      const scale = 3 / Math.sqrt(h);
      tangents[i] = scale * a * slopes[i];
      tangents[i + 1] = scale * b * slopes[i];
    }
  }
  let path = `M${points[0][0]},${points[0][1]}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    const third = (x1 - x0) / 3;
    path += `C${x0 + third},${y0 + tangents[i] * third} ${x1 - third},${y1 - tangents[i + 1] * third} ${x1},${y1}`;
  }
  return path;
}
/** A bar from the baseline with rounded top corners. */
function barPath(x: number, top: number, width: number, baseline: number) {
  const r = Math.min(4, width / 2, baseline - top);
  return `M${x},${baseline}V${top + r}Q${x},${top} ${x + r},${top}H${x + width - r}Q${x + width},${top} ${x + width},${top + r}V${baseline}Z`;
}
/** The tooltip keeps to the number; the table view states partial data. */
const tooltipTokens = (usage: TokenUsage) =>
  nonNegative(usage.total) ? formatTokens(usage.total) : "—";
const known = (usage?: TokenUsage) =>
  usage && nonNegative(usage.total) ? usage.total : 0;

export function TrendChart({
  overview,
  locale,
  animate,
  height,
  selectedDay,
  onSelectDay,
}: {
  overview: Overview;
  locale: string;
  animate: boolean;
  height: number;
  selectedDay?: string;
  onSelectDay: (day: string) => void;
}) {
  const { t } = useAppTranslation();
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const tooltip = useTooltip();
  const [hovered, setHovered] = useState<number>();
  const { trend, granularity } = overview;
  const compare = !!overview.previous;
  const daily = granularity === "day";
  const left = 44;
  const bottom = 26;
  // Room for the lifted line and the peak label above the tallest bar.
  const top = 32;
  const plotWidth = Math.max(0, width - left);
  const plotHeight = height - bottom - top;
  const max = Math.max(
    1,
    ...trend.map((item) => Math.max(known(item.usage), known(item.previous))),
  );
  const ticks = niceTicks(max);
  const scaleTop = ticks.at(-1)!;
  const y = (value: number) =>
    top + plotHeight - (value / scaleTop) * plotHeight;
  const band = trend.length ? plotWidth / trend.length : 0;
  const peak = trend.reduce(
    (best, item, index) =>
      known(item.usage) > known(trend[best].usage) ? index : best,
    0,
  );
  const center = (index: number) => left + band * index + band / 2;
  // The lines float a little above the bars so they read as the trend over
  // them rather than cutting through each bar's top. The gap never exceeds
  // the bar itself, so an empty day stays on the baseline.
  const lifted = (value: number) => y(value) - Math.min(12, y(0) - y(value));
  const current = trend.map(
    (item, index) =>
      [center(index), lifted(known(item.usage))] as [number, number],
  );
  const earlier = trend.flatMap((item, index) =>
    item.previous
      ? [[center(index), lifted(known(item.previous))] as [number, number]]
      : [],
  );
  const line = smoothPath(current);
  const baseline = y(0);
  const barWidth = Math.min(28, band * 0.56);
  const marked =
    hovered ?? trend.findIndex((item) => item.start === selectedDay);
  const labelEvery = Math.ceil(
    trend.length / Math.max(2, Math.floor(plotWidth / 56)),
  );
  return (
    <div ref={ref} className="overview-chart" style={{ height }}>
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={t("overview.trend.summary", {
            value: formatTokens(known(trend[peak]?.usage)),
          })}
          onMouseLeave={() => {
            setHovered(undefined);
            tooltip.hide();
          }}
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={left}
                x2={width}
                y1={y(tick)}
                y2={y(tick)}
                strokeWidth={1}
                style={{
                  stroke:
                    tick === 0
                      ? "var(--overview-axis)"
                      : "var(--overview-grid)",
                }}
              />
              <text
                className="overview-axis-text"
                x={left - 8}
                y={y(tick) + 4}
                textAnchor="end"
              >
                {formatTokens(tick)}
              </text>
            </g>
          ))}
          {trend.map((item, index) => (
            <rect
              key={item.start}
              className="overview-hover-band"
              data-active={hovered === index || selectedDay === item.start}
              x={left + band * index + 1}
              y={top - 6}
              width={Math.max(0, band - 2)}
              height={plotHeight + 6}
              rx={6}
            />
          ))}
          {/* Bars give each day its weight; the line over them shows the trend. */}
          <g data-animate={animate || undefined}>
            {trend.map((item, index) =>
              known(item.usage) > 0 ? (
                <path
                  key={item.start}
                  className="overview-trend-bar"
                  data-active={index === marked || undefined}
                  d={barPath(
                    center(index) - barWidth / 2,
                    y(known(item.usage)),
                    barWidth,
                    baseline,
                  )}
                />
              ) : null,
            )}
            {compare && earlier.length > 1 && (
              <path
                className="overview-trend-line"
                data-previous=""
                d={smoothPath(earlier)}
              />
            )}
            {line && (
              <path className="overview-trend-line" pathLength={1} d={line} />
            )}
          </g>
          {/* Like Highcharts' default, each point is marked while the points
              are sparse, so the line starts and ends on a dot rather than in a
              bare tip; dense ranges mark only the hovered or selected day. */}
          <g data-animate={animate || undefined}>
            {trend.map((item, index) => {
              const active = index === marked;
              if (!active && band < 24 && trend.length > 1) return null;
              return (
                <g key={item.start}>
                  {active && compare && item.previous && (
                    <circle
                      className="overview-trend-point"
                      data-previous=""
                      cx={center(index)}
                      cy={lifted(known(item.previous))}
                      r={3}
                    />
                  )}
                  <circle
                    className="overview-trend-point"
                    data-rest={!active || undefined}
                    cx={current[index][0]}
                    cy={current[index][1]}
                    r={active ? 4 : 3}
                  />
                </g>
              );
            })}
          </g>
          {known(trend[peak]?.usage) > 0 && (
            <text
              className="overview-value-text"
              x={current[peak][0]}
              y={current[peak][1] - 11}
              textAnchor="middle"
            >
              {formatTokens(known(trend[peak].usage))}
            </text>
          )}
          {trend.map((item, index) => (
            <g key={item.start}>
              {index % labelEvery === 0 && (
                <text
                  className="overview-axis-text"
                  x={center(index)}
                  y={height - 6}
                  textAnchor="middle"
                >
                  {formatAxisDay(item.start, locale, granularity)}
                </text>
              )}
              <rect
                className="overview-hit"
                data-clickable={daily || undefined}
                x={left + band * index}
                y={0}
                width={band}
                height={height - bottom}
                onClick={daily ? () => onSelectDay(item.start) : undefined}
                onMouseMove={(event) => {
                  setHovered(index);
                  tooltip.show(
                    <>
                      <b>{formatDayRange(item.start, item.end, locale)}</b>
                      <div className="overview-tooltip-row">
                        <span>
                          <i style={{ background: "var(--overview-viz-3)" }} />
                          {t("overview.trend.current")}
                        </span>
                        <b>{tooltipTokens(item.usage)}</b>
                      </div>
                      {compare && item.previous && (
                        <div className="overview-tooltip-row">
                          <span data-muted>
                            <i data-line="dashed" />
                            {t("overview.trend.previous")}
                          </span>
                          <b>{tooltipTokens(item.previous)}</b>
                        </div>
                      )}
                    </>,
                    event,
                  );
                }}
              />
            </g>
          ))}
        </svg>
      )}
      {tooltip.element}
    </div>
  );
}

export function TrendTable({
  overview,
  locale,
}: {
  overview: Overview;
  locale: string;
}) {
  const { t } = useAppTranslation();
  const compare = !!overview.previous;
  return (
    <table className="overview-data-table">
      <thead>
        <tr>
          <th>{t("overview.trend.period")}</th>
          <th className="numeric">{t("overview.trend.current")}</th>
          {compare && (
            <th className="numeric">{t("overview.trend.previous")}</th>
          )}
          {compare && <th className="numeric">{t("overview.trend.change")}</th>}
        </tr>
      </thead>
      <tbody>
        {overview.trend.map((item) => {
          const current = item.usage.total;
          const previous = item.previous?.total;
          return (
            <tr key={item.start}>
              <td>{formatDayRange(item.start, item.end, locale)}</td>
              <td className="numeric">
                <TokenCount usage={item.usage} />
              </td>
              {compare && (
                <td className="numeric">
                  {item.previous ? <TokenCount usage={item.previous} /> : "—"}
                </td>
              )}
              {compare && (
                <td className="numeric">
                  {nonNegative(current) && nonNegative(previous) && previous
                    ? `${current >= previous ? "+" : "−"}${formatPercent(Math.abs(current - previous) / previous, locale)}`
                    : "—"}
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const level = (value: number, max: number) =>
  value <= 0
    ? 0
    : value < max * 0.2
      ? 1
      : value < max * 0.45
        ? 2
        : value < max * 0.75
          ? 3
          : 4;

function cellText(cell: Overview["activity"][number][number], t: Translate) {
  if (!cell.runs && !cell.tokens) return t("overview.activity.noActivity");
  const tokens =
    cell.partial && !cell.tokens
      ? t("overview.unavailable")
      : `${formatTokens(cell.tokens)}${cell.partial ? ` · ${t("overview.partialData")}` : ""}`;
  return `${tokens} · ${t("overview.trend.runs", { count: cell.runs })}`;
}

export function ActivityHeatmap({
  overview,
  weekStart,
  locale,
  animate,
}: {
  overview: Overview;
  weekStart: number;
  locale: string;
  animate: boolean;
}) {
  const { t } = useAppTranslation();
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const tooltip = useTooltip();
  const left = 44;
  const bottom = 22;
  const column = Math.max(0, (width - left) / 24);
  // A fixed row height keeps weekday labels readable at any width.
  const row = 24;
  const radius = Math.max(2.5, Math.min(column, row) / 2 - 1.5);
  const height = 7 * row + bottom;
  const max = Math.max(
    1,
    ...overview.activity.flat().map((cell) => cell.tokens),
  );
  const fills = ["var(--overview-track)", ...VIZ];
  return (
    <div ref={ref} className="overview-chart">
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={t("overview.activity.summary")}
          onMouseLeave={tooltip.hide}
        >
          {overview.activity.map((hours, rowIndex) => {
            const weekday = (rowIndex + weekStart) % 7;
            const cy = rowIndex * row + row / 2;
            return (
              <g key={rowIndex}>
                <text className="overview-axis-text" x={0} y={cy + 4}>
                  {weekdayName(weekday, locale)}
                </text>
                {hours.map((cell, hour) => {
                  const value = level(cell.tokens, max);
                  return (
                    <g key={hour}>
                      <circle
                        className="overview-pop"
                        style={{
                          fill: fills[value],
                          ...(animate
                            ? {
                                animationDelay: `${hour * 14 + rowIndex * 30}ms`,
                              }
                            : { animation: "none" }),
                        }}
                        cx={left + hour * column + column / 2}
                        cy={cy}
                        r={value ? radius : radius * 0.55}
                      />
                      <rect
                        className="overview-hit"
                        x={left + hour * column}
                        y={rowIndex * row}
                        width={column}
                        height={row}
                        onMouseMove={(event) =>
                          tooltip.show(
                            <>
                              <b>
                                {weekdayName(weekday, locale)}{" "}
                                {t("overview.activity.hourRange", {
                                  start: hourLabel(hour, locale),
                                  end: hourLabel((hour + 1) % 24, locale),
                                })}
                              </b>
                              <div>{cellText(cell, t)}</div>
                            </>,
                            event,
                          )
                        }
                      />
                    </g>
                  );
                })}
              </g>
            );
          })}
          {[0, 6, 12, 18, 23].map((hour) => (
            <text
              key={hour}
              className="overview-axis-text"
              x={left + hour * column + column / 2}
              y={height - 4}
              textAnchor="middle"
            >
              {hourLabel(hour, locale)}
            </text>
          ))}
        </svg>
      )}
      {tooltip.element}
    </div>
  );
}

export function ActivityTable({
  overview,
  weekStart,
  locale,
}: {
  overview: Overview;
  weekStart: number;
  locale: string;
}) {
  const { t } = useAppTranslation();
  return (
    <table className="overview-data-table">
      <thead>
        <tr>
          <th>{t("overview.activity.weekday")}</th>
          <th className="numeric">{t("overview.activity.tokens")}</th>
          <th className="numeric">{t("overview.activity.runs")}</th>
          <th>{t("overview.activity.peakHour")}</th>
        </tr>
      </thead>
      <tbody>
        {overview.activity.map((hours, rowIndex) => {
          const tokens = hours.reduce((sum, cell) => sum + cell.tokens, 0);
          const runs = hours.reduce((sum, cell) => sum + cell.runs, 0);
          const most = Math.max(...hours.map((cell) => cell.tokens));
          const peak = tokens
            ? hours.findIndex((cell) => cell.tokens === most)
            : -1;
          return (
            <tr key={rowIndex}>
              <td>{weekdayName((rowIndex + weekStart) % 7, locale)}</td>
              <td className="numeric">
                {tokens || !hours.some((cell) => cell.partial)
                  ? formatTokens(tokens)
                  : t("overview.unavailable")}
              </td>
              <td className="numeric">{runs}</td>
              <td>
                {peak < 0
                  ? "—"
                  : t("overview.activity.hourRange", {
                      start: hourLabel(peak, locale),
                      end: hourLabel((peak + 1) % 24, locale),
                    })}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function topicLabel(topic: OverviewTopic, t: Translate) {
  return topic.label ?? t("overview.topics.other");
}

/** A column in the focus areas chart: a local group or an AI theme. */
export interface TopicGroup {
  id: string;
  label: string;
  /** Where the grouping came from, or the AI theme's description. */
  detail: string;
  Icon: LucideIcon;
  conversationIds: string[];
}

const DOTS_PER_ROW = 8;
const MAX_DOTS = 48;
export function TopicDots({
  overview,
  groups,
  selected,
  onSelect,
  locale,
  animate,
  conversationTitle,
}: {
  overview: Overview;
  groups: TopicGroup[];
  selected?: string;
  onSelect: (group: TopicGroup) => void;
  locale: string;
  animate: boolean;
  conversationTitle: (conversation: OverviewConversation) => string;
}) {
  const { t } = useAppTranslation();
  const tooltip = useTooltip();
  const conversations = new Map(
    overview.conversations.map((item) => [item.id, item]),
  );
  const total = overview.usage.total;
  const rows = Math.ceil(
    Math.min(
      MAX_DOTS,
      Math.max(1, ...groups.map((group) => group.conversationIds.length)),
    ) / DOTS_PER_ROW,
  );
  // Quartiles across every conversation, so shades compare between areas.
  const sorted = overview.conversations
    .map((item) => known(item.usage))
    .sort((a, b) => a - b);
  const quantile = (p: number) =>
    sorted[Math.floor((sorted.length - 1) * p)] ?? 0;
  const cuts = [quantile(0.25), quantile(0.5), quantile(0.8)];
  const shade = (tokens: number) =>
    VIZ[cuts.filter((cut) => tokens > cut).length];
  return (
    <div className="overview-topics" onMouseLeave={tooltip.hide}>
      {groups.map((group) => {
        const tokens = group.conversationIds.reduce(
          (sum, id) => sum + known(conversations.get(id)?.usage),
          0,
        );
        const share = nonNegative(total)
          ? formatPercent(total ? tokens / total : 0, locale)
          : undefined;
        const count = t("overview.topics.conversations", {
          count: group.conversationIds.length,
        });
        const shown = group.conversationIds.slice(0, MAX_DOTS);
        const hidden = group.conversationIds.length - shown.length;
        return (
          <OverflowHint key={group.id} content={group.label}>
            <button
              data-slot="overview-button"
              type="button"
              className="overview-topic"
              aria-pressed={selected === group.id}
              aria-label={[
                group.label,
                count,
                share && t("overview.topics.share", { percent: share }),
              ]
                .filter(Boolean)
                .join(", ")}
              onClick={() => onSelect(group)}
            >
              <span
                className="overview-topic-dots"
                style={{ minHeight: rows * 14 }}
              >
                {shown.map((id, index) => {
                  const conversation = conversations.get(id);
                  if (!conversation) return null;
                  return (
                    <i
                      key={id}
                      style={{
                        background: shade(known(conversation.usage)),
                        animationDelay: animate
                          ? `${Math.min(index * 22, 600)}ms`
                          : undefined,
                        animation: animate ? undefined : "none",
                      }}
                      onMouseMove={(event) =>
                        tooltip.show(
                          <>
                            <b>{conversationTitle(conversation)}</b>
                            <div>
                              <UsageValue usage={conversation.usage} t={t} /> ·{" "}
                              {t("overview.trend.runs", {
                                count: conversation.runs,
                              })}
                            </div>
                          </>,
                          event,
                        )
                      }
                    />
                  );
                })}
                {hidden > 0 && (
                  <span className="overview-topic-more">+{hidden}</span>
                )}
              </span>
              <span className="overview-topic-name">
                <group.Icon aria-hidden="true" />
                <span className="truncate">{group.label}</span>
              </span>
              <span className="overview-topic-meta">
                {share && <b>{share}</b>}
                {share && " · "}
                {count}
              </span>
              <span className="overview-topic-detail">{group.detail}</span>
            </button>
          </OverflowHint>
        );
      })}
      {tooltip.element}
    </div>
  );
}
