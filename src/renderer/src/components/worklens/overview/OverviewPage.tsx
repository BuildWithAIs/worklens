import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import {
  ArrowUpRight,
  CalendarDays,
  ChartColumn,
  ChevronDown,
  ChevronRight,
  FilePen,
  FilePlus,
  FileSearch,
  FileText,
  FolderOpen,
  Info,
  LoaderCircle,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  SquareTerminal,
  Table2,
  TextSearch,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Hint } from "@/components/ui/tooltip";
import { BackgroundEffect } from "@/components/worklens/BackgroundEffect";
import { BrandIcon, ProviderIcon } from "@/components/worklens/ProviderIcon";
import { connectorCatalog } from "@/components/worklens/connectors/catalog";
import { languageTag, useAppTranslation } from "@/i18n";
import { formatCost, formatTokens } from "@/lib/usage-format";
import {
  formatDay,
  formatDayRange,
  formatLastActive,
  formatPercent,
  formatShare,
  hourLabel,
  weekdayName,
} from "@/lib/overview-format";
import {
  DEFAULT_RANGE,
  RANGE_PRESETS,
  resolveRange,
  weekStartFor,
  type RangePreset,
} from "@/lib/overview-range";
import {
  addDays,
  dayKey,
  daysBetween,
  parseDay,
} from "../../../../../shared/date-range";
import { nonNegative } from "../../../../../shared/usage";
import type {
  DateRange,
  Overview,
  OverviewConversation,
  ProviderInfo,
  ReportSummaryState,
  Settings,
  TokenUsage,
} from "../../../../../shared/contracts";
import {
  ActivityHeatmap,
  ActivityTable,
  TOPIC_ICONS,
  TopicDots,
  TrendChart,
  TrendTable,
  VIZ,
  topicLabel,
  type TopicGroup,
} from "./OverviewCharts";
import {
  ConversationDrawer,
  TokenCount,
  type TableFilter,
} from "./OverviewTable";
import { ReportSetupDialog } from "./ReportSetupDialog";
import { ReportBoundary } from "./ReportBoundary";
import "./overview.css";

const api = window.worklens;
// Kept while the app runs; a restart opens on the default range again.
let rememberedPreset: RangePreset = DEFAULT_RANGE;
const TREND_HEIGHT = 220;
const reducedMotion = () =>
  matchMedia("(prefers-reduced-motion: reduce)").matches;

function useCountUp(value: number, animate: boolean) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const start = from.current;
    from.current = value;
    if (!animate || start === value || reducedMotion()) {
      setShown(value);
      return;
    }
    let frame = 0;
    const began = performance.now();
    const step = (now: number) => {
      const progress = Math.min(1, (now - began) / 650);
      setShown(start + (value - start) * (1 - (1 - progress) ** 3));
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value, animate]);
  return shown;
}

/** The change from the previous period; hovering names that period. */
function Delta({
  current,
  previous,
  period,
  format,
}: {
  current?: number;
  previous?: number;
  period?: DateRange & { partial: boolean };
  format: (value: number) => string;
}) {
  const { t, language } = useAppTranslation();
  if (!nonNegative(current) || !nonNegative(previous) || !previous || !period)
    return null;
  const locale = languageTag(language);
  const change = (current - previous) / previous;
  const value = formatPercent(Math.abs(change), locale);
  return (
    <Hint
      content={t(
        period.partial ? "overview.deltaHintPartial" : "overview.deltaHint",
        {
          range: formatDayRange(period.start, period.end, locale),
          value: format(previous),
        },
      )}
    >
      <span
        className="overview-delta"
        tabIndex={0}
        aria-label={t("overview.delta", {
          value: `${change >= 0 ? "+" : "−"}${value}`,
        })}
      >
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d={change >= 0 ? "M5 1 9.5 9h-9z" : "M5 9 .5 1h9z"} />
        </svg>
        {value}
      </span>
    </Hint>
  );
}

/** The report's first rows in outline, with one sheen across them all. */
function ReportSkeleton() {
  const block = (width: number | string, height: number) => (
    <span className="overview-skeleton-block" style={{ width, height }} />
  );
  const rows = (count: number) =>
    Array.from({ length: count }, (_, index) => (
      <span key={index} className="overview-skeleton-row">
        {block(72 + ((index * 23) % 40), 10)}
        {block(36, 10)}
      </span>
    ));
  return (
    <div className="overview-grid" aria-busy="true">
      <div
        className="overview-card overview-skeleton"
        data-span="5"
        data-area="tokens"
      >
        {block(56, 12)}
        {block(170, 40)}
        {block("100%", 8)}
        {rows(4)}
      </div>
      <div
        className="overview-card overview-skeleton"
        data-span="3"
        data-area="sessions"
      >
        {block(96, 12)}
        {block(48, 40)}
        {block("100%", 8)}
        {rows(4)}
      </div>
      <div
        className="overview-card overview-skeleton"
        data-span="4"
        data-area="insight"
      >
        {block(88, 12)}
        {block("100%", 12)}
        {block("92%", 12)}
        {block("96%", 12)}
        {block("58%", 12)}
      </div>
      <div
        className="overview-card overview-skeleton"
        data-span="7"
        data-area="trend"
      >
        {block(96, 12)}
        <span className="overview-skeleton-fill" />
      </div>
      <div
        className="overview-card overview-skeleton"
        data-span="5"
        data-area="activity"
      >
        {block(88, 12)}
        <span className="overview-skeleton-fill" />
      </div>
    </div>
  );
}

/** An explanation that only matters to some readers, behind an icon. */
/** A colour scale as dots alone; hover names its direction. */
function Ramp({ label, colors }: { label: string; colors: readonly string[] }) {
  return (
    <Hint content={label}>
      <span
        className="overview-ramp"
        role="img"
        aria-label={label}
        tabIndex={0}
      >
        {colors.map((color) => (
          <i key={color} style={{ background: color }} />
        ))}
      </span>
    </Hint>
  );
}

function InfoHint({ content, label }: { content: string; label: string }) {
  return (
    <Hint content={content}>
      <button
        data-slot="overview-button"
        type="button"
        className="overview-info"
        aria-label={label}
      >
        <Info aria-hidden="true" />
      </button>
    </Hint>
  );
}

function Card({
  area,
  span,
  title,
  info,
  label,
  actions,
  scroll,
  children,
  cardRef,
}: {
  area: string;
  span: number;
  title?: string;
  info?: string;
  label?: string;
  actions?: ReactNode;
  /** Long lists scroll inside the card instead of growing the row. */
  scroll?: boolean;
  children: ReactNode;
  cardRef?: Ref<HTMLElement>;
}) {
  return (
    <section
      ref={cardRef}
      className="overview-card"
      data-area={area}
      data-span={span}
      aria-label={title ?? label}
    >
      {title && (
        <div className="overview-card-head">
          <h2 data-slot="overview-heading" className="overview-card-title">
            {title}
            {info && <InfoHint content={info} label={info} />}
          </h2>
          {actions && <div className="overview-head-actions">{actions}</div>}
        </div>
      )}
      <div className="overview-card-body" data-scroll={scroll || undefined}>
        {children}
      </div>
    </section>
  );
}

function ViewToggle({
  value,
  onChange,
}: {
  value: "chart" | "table";
  onChange: (value: "chart" | "table") => void;
}) {
  const { t } = useAppTranslation();
  return (
    <span
      className="overview-toggle"
      role="group"
      aria-label={t("overview.trend.view")}
    >
      {(
        [
          ["chart", ChartColumn, t("overview.trend.chart")],
          ["table", Table2, t("overview.trend.table")],
        ] as const
      ).map(([key, Icon, label]) => (
        <button
          key={key}
          data-slot="overview-button"
          type="button"
          aria-pressed={value === key}
          aria-label={label}
          onClick={() => onChange(key)}
        >
          <Icon aria-hidden="true" />
        </button>
      ))}
    </span>
  );
}

function RangeMenu({
  value,
  onChange,
  now,
  locale,
}: {
  value: RangePreset;
  onChange: (value: RangePreset) => void;
  now: Date;
  locale: string;
}) {
  const { t } = useAppTranslation();
  const current = resolveRange(value, now);
  return (
    // The shared dropdown, so the range reads and moves like the app's other
    // single-choice menus: a check marks the choice, arrows move between them.
    <DropdownMenu>
      <Hint content={formatDayRange(current.start, current.end, locale)}>
        <DropdownMenuTrigger
          render={
            <button
              data-slot="overview-button"
              type="button"
              className="overview-range-pill"
            />
          }
          aria-label={`${t("overview.range.label")}: ${t(`overview.range.${value}`)}`}
        >
          <CalendarDays aria-hidden="true" />
          {t(`overview.range.${value}`)}
          <ChevronDown aria-hidden="true" />
        </DropdownMenuTrigger>
      </Hint>
      <DropdownMenuContent
        align="end"
        className="w-auto min-w-40"
        aria-label={t("overview.range.label")}
      >
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => onChange(next as RangePreset)}
        >
          {RANGE_PRESETS.map((item) => (
            <DropdownMenuRadioItem key={item} value={item} closeOnClick>
              {t(`overview.range.${item}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Same meaning as the usage popover: input violet, output gray, cache reads
// lighter and cache writes deeper violet.
const SEGMENTS = [
  { key: "input", label: "usage.input", color: "var(--overview-input)" },
  { key: "output", label: "usage.output", color: "var(--overview-output)" },
  {
    key: "cacheRead",
    label: "usage.cacheRead",
    color: "var(--overview-cache-read)",
  },
  {
    key: "cacheWrite",
    label: "usage.cacheWrite",
    color: "var(--overview-cache-write)",
  },
] as const;
type SegmentKey = (typeof SEGMENTS)[number]["key"];

/** Blocks in the composition meter, about 2.5% of tokens each. */
const METER = 40;
/**
 * Each part's blocks in the meter. A part of 1% or more keeps at least one
 * block; the largest part absorbs the rounding.
 */
function meterBlocks(usage: TokenUsage) {
  const sum = SEGMENTS.reduce(
    (total, part) => total + (usage[part.key] ?? 0),
    0,
  );
  if (!sum) return [];
  const counts = SEGMENTS.map((part) => {
    const exact = ((usage[part.key] ?? 0) / sum) * METER;
    return exact >= METER * 0.01 ? Math.max(1, Math.round(exact)) : 0;
  });
  const largest = counts.indexOf(Math.max(...counts));
  counts[largest] += METER - counts.reduce((total, count) => total + count, 0);
  return SEGMENTS.flatMap((part, index) =>
    Array.from({ length: counts[index] }, () => part),
  );
}
/** The first row leads; the rest step back so the list has an order. */
const rankColor = (index: number) =>
  index === 0 ? "var(--overview-viz-3)" : "var(--overview-viz-1)";

// Connectors reach outside services; everything else runs on this computer.
const CONNECTOR_TOOLS = new Set(["jira", "github", "confluence", "jev", "web"]);
const isConnectorTool = (name: string) =>
  CONNECTOR_TOOLS.has(name) ||
  name.startsWith("mcp__") ||
  name.includes("_mcp_");
const BUILT_IN_ICONS: Record<string, LucideIcon> = {
  read: FileText,
  write: FilePlus,
  edit: FilePen,
  bash: SquareTerminal,
  powershell: SquareTerminal,
  grep: TextSearch,
  find: FileSearch,
  ls: FolderOpen,
  tool_search: Search,
};
function ToolIcon({ name }: { name: string }) {
  // Web tools come from the Tavily connector.
  const id = name === "web" ? "tavily" : name;
  const brand = connectorCatalog.find((entry) => entry.id === id)?.icon;
  if (brand) return <BrandIcon source={brand} />;
  const Icon = BUILT_IN_ICONS[name] ?? (isConnectorTool(name) ? Plug : Wrench);
  return <Icon aria-hidden="true" />;
}

function cacheHit(usage: TokenUsage) {
  const { input, cacheRead, cacheWrite } = usage;
  if (
    !nonNegative(input) ||
    !nonNegative(cacheRead) ||
    !nonNegative(cacheWrite)
  )
    return undefined;
  const prompt = input + cacheRead + cacheWrite;
  return prompt ? cacheRead / prompt : undefined;
}

type SummaryView = {
  key: string;
  state?: ReportSummaryState;
  generating?: boolean;
  error?: "failed" | "invalid";
};

export function OverviewPage(props: Parameters<typeof Report>[0]) {
  return (
    <ReportBoundary>
      <Report {...props} />
    </ReportBoundary>
  );
}

function Report({
  settings,
  providers,
  revision,
  onOpenConversation,
  onNewConversation,
  save,
  onManageModels,
}: {
  onManageModels: () => void;
  settings: Settings;
  providers: ProviderInfo[];
  /** Changes when conversations change, so the figures refresh. */
  revision: string;
  onOpenConversation: (id: string) => void;
  onNewConversation: () => void;
  save: (patch: Partial<Settings>) => Promise<unknown>;
}) {
  const { t, language } = useAppTranslation();
  const locale = languageTag(language);
  const weekStart = useMemo(
    () =>
      weekStartFor(
        navigator.language.toLowerCase().startsWith(language)
          ? navigator.language
          : locale,
      ),
    [language, locale],
  );
  const [preset, setPreset] = useState(rememberedPreset);
  // A result belongs to the request it answered, so a new range never shows
  // the previous range's figures as its own.
  const [result, setResult] = useState<{ key: string; value: Overview }>();
  const [failed, setFailed] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [filter, setFilter] = useState<TableFilter>();
  const [trendView, setTrendView] = useState<"chart" | "table">("chart");
  const [activityView, setActivityView] = useState<"chart" | "table">("chart");
  const [summary, setSummary] = useState<SummaryView>();
  const [setupOpen, setSetupOpen] = useState(false);
  const animate = useRef(true);
  const now = new Date();
  const range = resolveRange(preset, now);
  const key = JSON.stringify({ ...range, weekStart });
  const aiEnabled = !!settings.reportSummary?.enabled;
  const summaryKey = JSON.stringify({
    start: range.start,
    end: range.end,
    language,
  });

  useEffect(() => {
    let current = true;
    setFailed(undefined);
    api
      .invoke("overview", JSON.parse(key))
      .then((value) => {
        if (current) setResult({ key, value });
      })
      .catch(() => {
        if (current) setFailed(key);
      });
    return () => {
      current = false;
    };
  }, [key, revision, attempt]);
  useEffect(() => {
    if (!aiEnabled) return;
    let current = true;
    api
      .invoke("reportSummary", JSON.parse(summaryKey))
      .then((state) => {
        if (current)
          setSummary((previous) =>
            previous?.key === summaryKey && previous.generating
              ? previous
              : { key: summaryKey, state },
          );
      })
      .catch(() => {
        if (current) setSummary({ key: summaryKey });
      });
    return () => {
      current = false;
    };
  }, [aiEnabled, summaryKey, revision]);
  // Background refreshes keep the charts still; a new range animates.
  useEffect(() => {
    animate.current = false;
  }, [revision]);

  const generate = () => {
    const requestKey = summaryKey;
    setSummary((previous) => ({
      key: requestKey,
      state: previous?.key === requestKey ? previous.state : undefined,
      generating: true,
    }));
    api
      .invoke("generateReportSummary", JSON.parse(requestKey))
      .then((state) =>
        setSummary((previous) =>
          previous?.key === requestKey ? { key: requestKey, state } : previous,
        ),
      )
      .catch((error) =>
        setSummary((previous) =>
          previous?.key === requestKey
            ? {
                key: requestKey,
                state: previous.state,
                error: String(error).includes("REPORT_SUMMARY_INVALID")
                  ? "invalid"
                  : "failed",
              }
            : previous,
        ),
      );
  };
  const changeRange = (next: RangePreset) => {
    if (next === preset) return;
    rememberedPreset = next;
    animate.current = true;
    setFilter(undefined);
    setPreset(next);
  };
  const applyFilter = (next?: TableFilter) => {
    animate.current = false;
    setFilter(next);
  };

  const modelNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const provider of providers)
      for (const model of provider.models)
        names.set(`${provider.id}\u0000${model.id}`, model.name);
    return names;
  }, [providers]);
  const modelName = useCallback(
    (provider?: string, model?: string) =>
      model
        ? (modelNames.get(`${provider}\u0000${model}`) ?? model)
        : t("overview.models.unattributed"),
    [modelNames, t],
  );
  const providerName = useCallback(
    (id: string) => providers.find((item) => item.id === id)?.name ?? id,
    [providers],
  );
  const conversationTitle = useCallback(
    (item: OverviewConversation) => item.title ?? t("overview.list.untitled"),
    [t],
  );

  const stale = !!result && result.key !== key;
  const shown = result?.value;
  const empty = !!shown && !shown.conversations.length;
  // Nothing recorded yet: no range or summary settings to offer.
  const firstUse =
    empty && !shown.retainedSessions && !shown.unreadableSessions;
  // Asked once, the first time there are conversations to summarize.
  const asked = useRef(false);
  const hasConversations = !!shown?.conversations.length;
  useEffect(() => {
    if (asked.current || settings.reportSummary || !hasConversations) return;
    asked.current = true;
    setSetupOpen(true);
  }, [settings.reportSummary, hasConversations]);
  const header = (
    <header className="chat-header overview-header">
      <div className="overview-title">
        <h1 data-slot="overview-title">{t("overview.title")}</h1>
        <InfoHint content={t("overview.scope")} label={t("overview.about")} />
      </div>
      <div className="chat-header-actions overview-range-info">
        {stale && failed !== key && (
          // The dimmed cards already show it; announced, not shown, so the
          // range button never shifts for a moment.
          <span className="sr-only" role="status">
            {t("overview.updating")}
          </span>
        )}
        {!firstUse && (
          <>
            <RangeMenu
              value={preset}
              onChange={changeRange}
              now={now}
              locale={locale}
            />
            <Hint content={t("overview.setup.open")}>
              <button
                data-slot="overview-button"
                type="button"
                className="overview-icon-button overview-settings-button"
                aria-label={t("overview.setup.open")}
                onClick={() => setSetupOpen(true)}
              >
                <Sparkles aria-hidden="true" />
              </button>
            </Hint>
          </>
        )}
      </div>
    </header>
  );

  let body: ReactNode;
  if (failed === key)
    body = (
      <div className="overview-card overview-state" data-span="12">
        <h2 data-slot="overview-heading">{t("overview.loadFailed")}</h2>
        <div className="overview-state-actions">
          <Button variant="outline" onClick={() => setAttempt((n) => n + 1)}>
            {t("overview.retry")}
          </Button>
        </div>
      </div>
    );
  else if (!shown) body = <ReportSkeleton />;
  // A quiet range keeps the dashboard, with zeros, so switching ranges never
  // leaves the page; only a first visit has nothing to lay out yet.
  else if (firstUse)
    body = (
      <div className="overview-empty" data-stale={stale || undefined}>
        <h2 data-slot="overview-heading">{t("overview.empty.firstTitle")}</h2>
        <p>{t("overview.empty.firstDescription")}</p>
        <div className="overview-state-actions">
          <Button onClick={onNewConversation}>
            <Plus />
            {t("app.newChat")}
          </Button>
        </div>
      </div>
    );
  else
    body = (
      <OverviewCards
        overview={shown}
        stale={stale}
        settings={settings}
        locale={locale}
        weekStart={weekStart}
        animate={animate.current && !stale}
        filter={filter}
        trendView={trendView}
        activityView={activityView}
        onTrendView={setTrendView}
        onActivityView={setActivityView}
        onFilter={applyFilter}
        onOpenConversation={onOpenConversation}
        modelName={modelName}
        providerName={providerName}
        conversationTitle={conversationTitle}
        summary={
          aiEnabled
            ? summary?.key === summaryKey
              ? summary
              : { key: summaryKey }
            : undefined
        }
        onGenerate={generate}
        onOpenSetup={() => setSetupOpen(true)}
      />
    );

  return (
    <div className="overview-page" data-empty={firstUse || undefined}>
      {header}
      <div className="overview-scroll">
        <div className="overview-content">
          {body}
          {!!shown?.unreadableSessions && (
            <div className="overview-note">
              {t("overview.unreadable", { count: shown.unreadableSessions })}
            </div>
          )}
        </div>
      </div>
      <ReportSetupDialog
        open={setupOpen}
        onOpenChange={setSetupOpen}
        settings={settings}
        providers={providers}
        save={async (patch) => {
          await save(patch);
        }}
        onManageModels={onManageModels}
      />
    </div>
  );
}

function SummaryCard({
  view,
  settings,
  locale,
  conversations,
  onGenerate,
  onOpenSetup,
  modelName,
}: {
  view: SummaryView;
  settings: Settings;
  locale: string;
  conversations: number;
  onGenerate: () => void;
  onOpenSetup: () => void;
  modelName: (provider?: string, model?: string) => string;
}) {
  const { t } = useAppTranslation();
  const result = view.state?.summary;
  const hasModels = !!settings.reportSummary?.models.length;
  const summaryModel = result
    ? modelName(result.model.provider, result.model.model)
    : "";
  const summaryDetails = result
    ? {
        tokens: formatTokens(result.usage.total),
        time: formatLastActive(result.generatedAt, new Date(), locale),
      }
    : { tokens: "", time: "" };
  const summaryMeta = t("overview.summary.meta", {
    model: summaryModel,
    ...summaryDetails,
  });
  const effect = settings.backgroundEffect ?? "none";
  const regenerate = t(
    view.state?.stale
      ? "overview.summary.stale"
      : "overview.summary.regenerate",
  );
  return (
    <Card area="insight" span={4} label={t("overview.summary.label")}>
      <div className="overview-insight-layer" aria-hidden="true">
        {effect !== "none" && <BackgroundEffect settings={settings} />}
      </div>
      <div className="overview-insight">
        <div className="overview-insight-top">
          <span className="overview-card-title overview-insight-label">
            <Sparkles aria-hidden="true" />
            {t("overview.summary.label")}
          </span>
          {result && !view.generating && (
            <Hint content={regenerate}>
              <button
                data-slot="overview-button"
                type="button"
                className="overview-icon-button"
                // A dot, not a sentence: a range that includes today is
                // almost always newer than its summary.
                data-stale={view.state?.stale || undefined}
                aria-label={regenerate}
                onClick={onGenerate}
              >
                <RefreshCw aria-hidden="true" />
              </button>
            </Hint>
          )}
        </div>
        {view.generating ? (
          <div className="overview-summary-status" role="status">
            <LoaderCircle className="animate-spin" aria-hidden="true" />
            {t("overview.summary.generating")}
          </div>
        ) : result ? (
          <div className="overview-summary-body">
            <div className="overview-summary-headline">{result.summary}</div>
            {!!result.highlights.length && (
              <ul className="overview-bubbles">
                {result.highlights.map((text, index) => (
                  <li key={index} style={{ animationDelay: `${index * 60}ms` }}>
                    {text}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="overview-summary-intro">
            {!hasModels
              ? t("overview.summary.noModels")
              : conversations
                ? t("overview.summary.intro")
                : t("overview.summary.nothing")}
          </div>
        )}
        {view.error && !view.generating && (
          <div className="overview-summary-error" role="alert">
            {t(
              view.error === "invalid"
                ? "overview.summary.invalid"
                : "overview.summary.failed",
            )}
          </div>
        )}
        {result && !view.generating && (
          <Hint content={summaryMeta} truncatedOnly>
            <span
              className="overview-summary-meta"
              role="note"
              aria-label={summaryMeta}
              tabIndex={0}
            >
              <span className="truncate">{summaryModel}</span>
              <span className="overview-summary-details">
                {t("overview.summary.details", summaryDetails)}
              </span>
            </span>
          </Hint>
        )}
        {!result && !view.generating && (!hasModels || !!conversations) && (
          <div className="overview-insight-action">
            {hasModels ? (
              <Button size="sm" onClick={onGenerate}>
                <Sparkles />
                {view.error
                  ? t("overview.retry")
                  : t("overview.summary.generate")}
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={onOpenSetup}>
                {t("overview.summary.chooseModel")}
                <ChevronRight />
              </Button>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

function OverviewCards({
  overview,
  stale,
  settings,
  locale,
  weekStart,
  animate,
  filter,
  trendView,
  activityView,
  onTrendView,
  onActivityView,
  onFilter,
  onOpenConversation,
  modelName,
  providerName,
  conversationTitle,
  summary,
  onGenerate,
  onOpenSetup,
}: {
  overview: Overview;
  stale: boolean;
  settings: Settings;
  locale: string;
  weekStart: number;
  animate: boolean;
  filter?: TableFilter;
  trendView: "chart" | "table";
  activityView: "chart" | "table";
  onTrendView: (view: "chart" | "table") => void;
  onActivityView: (view: "chart" | "table") => void;
  onFilter: (filter?: TableFilter) => void;
  onOpenConversation: (id: string) => void;
  modelName: (provider?: string, model?: string) => string;
  providerName: (id: string) => string;
  conversationTitle: (item: OverviewConversation) => string;
  /** Present when AI summaries are on. */
  summary?: SummaryView;
  onGenerate: () => void;
  onOpenSetup: () => void;
}) {
  const { t } = useAppTranslation();
  const [part, setPart] = useState<SegmentKey>();
  const { usage, previous, sessions } = overview;
  const blocks = meterBlocks(usage);
  const total = usage.total;
  const knownTotal = nonNegative(total);
  const shownTokens = useCountUp(total ?? 0, animate);
  const shownActive = useCountUp(sessions.active, animate);
  const hit = cacheHit(usage);
  const previousHit = previous && cacheHit(previous.usage);
  const points =
    hit !== undefined && previousHit !== undefined
      ? Math.round((hit - previousHit) * 100)
      : undefined;
  const share = (value?: number) =>
    knownTotal && total && nonNegative(value)
      ? formatShare(value / total, locale)
      : "—";
  const start = parseDay(overview.range.start)!;
  const days = daysBetween(start, parseDay(overview.range.end)!) + 1;
  const activeDays = new Set(overview.activeDays);
  // A single day shows its hours; one cell for the whole day says nothing.
  const strip =
    days === 1
      ? overview.activity[(start.getDay() - weekStart + 7) % 7].map(
          (cell, hour) => ({
            key: String(hour),
            active: cell.runs > 0 || cell.tokens > 0,
          }),
        )
      : Array.from({ length: days }, (_, index) => {
          const day = dayKey(addDays(start, index));
          return { key: day, active: activeDays.has(day) };
        });
  const stripLabel =
    days === 1
      ? t("overview.sessions.activeHours", {
          count: strip.filter((item) => item.active).length,
          total: strip.length,
        })
      : t("overview.sessions.activeDays", {
          count: activeDays.size,
          total: days,
        });
  const cost = usage.cost;
  const aiResult = summary?.state?.summary;
  const top = overview.topics.find((topic) => topic.source !== "other");
  // A highlight needs a named area and enough conversations to mean something.
  const highlight =
    !summary && top && knownTotal && total && overview.conversations.length >= 3
      ? top
      : undefined;
  const effect = settings.backgroundEffect ?? "none";
  const sideCard = !!summary || !!highlight;

  const conversationIds = new Set(
    overview.conversations.map((item) => item.id),
  );
  // An earlier summary may name only conversations outside this range; the
  // range's own topics then stand in.
  const aiGroups: TopicGroup[] = (aiResult?.themes ?? [])
    .map((theme, index) => ({
      id: `ai:${index}`,
      label: theme.title,
      detail: theme.description,
      Icon: Sparkles,
      conversationIds: theme.conversationIds.filter((id) =>
        conversationIds.has(id),
      ),
    }))
    .filter((group) => group.conversationIds.length);
  const groups: TopicGroup[] = aiGroups.length
    ? aiGroups
    : overview.topics.map((topic) => ({
        id: topic.id,
        label: topicLabel(topic, t),
        detail: t(`overview.topics.sources.${topic.source}`),
        Icon: TOPIC_ICONS[topic.source],
        conversationIds: topic.conversationIds,
      }));

  const knownActivity = overview.activity.some((row) =>
    row.some((cell) => cell.tokens > 0),
  );
  const byHour = Array.from({ length: 24 }, (_, hour) =>
    overview.activity.reduce((sum, row) => sum + row[hour].tokens, 0),
  );
  const byDay = overview.activity.map((row) =>
    row.reduce((sum, cell) => sum + cell.tokens, 0),
  );
  const peakHour = byHour.indexOf(Math.max(...byHour));
  const peakDay = byDay.indexOf(Math.max(...byDay));
  const nightRuns = overview.activity.reduce(
    (sum, row) =>
      sum +
      row.reduce(
        (inner, cell, hour) => inner + (hour >= 22 || hour < 6 ? cell.runs : 0),
        0,
      ),
    0,
  );

  const selectGroup = (group: TopicGroup) =>
    onFilter(
      (filter?.kind === "topic" && filter.topicId === group.id) ||
        (filter?.kind === "ids" && filter.id === group.id)
        ? undefined
        : group.id.startsWith("ai:")
          ? {
              kind: "ids",
              id: group.id,
              ids: new Set(group.conversationIds),
              label: group.label,
            }
          : { kind: "topic", topicId: group.id, label: group.label },
    );
  const selectDay = (day: string) =>
    onFilter(
      filter?.kind === "day" && filter.day === day
        ? undefined
        : { kind: "day", day, label: formatDay(day, locale) },
    );
  const knownModel = (value?: TokenUsage) =>
    value && nonNegative(value.total) ? value.total : 0;
  const maxModel = Math.max(
    1,
    ...overview.models.map((item) => knownModel(item.usage)),
  );
  const maxCalls = Math.max(1, ...overview.tools.map((item) => item.calls));
  const connectorTools = overview.tools.filter((item) =>
    isConnectorTool(item.name),
  );
  const builtInTools = overview.tools.filter(
    (item) => !isConnectorTool(item.name),
  );
  const fill = (index: number, width: number, background: string) => (
    <span className="overview-bar-track">
      <span
        className="overview-bar-fill"
        style={{
          width: `${width * 100}%`,
          background,
          animationDelay: animate ? `${index * 60}ms` : undefined,
          animation: animate ? undefined : "none",
        }}
      />
    </span>
  );
  const modelRow = (item: Overview["models"][number], index: number) => {
    const name = modelName(item.provider, item.model);
    const selected =
      filter?.kind === "model" &&
      filter.provider === item.provider &&
      filter.model === item.model;
    const content = (
      <>
        <span className="overview-bar-name">
          {item.model && <ProviderIcon provider={item.provider} />}
          <span className="truncate">{name}</span>
          {item.provider && item.model && (
            <span className="overview-bar-provider">
              {providerName(item.provider)}
            </span>
          )}
        </span>
        <span className="overview-bar-number" data-column="runs">
          {item.model ? item.runs.toLocaleString(locale) : ""}
        </span>
        <span className="overview-bar-value">
          <TokenCount usage={item.usage} />
        </span>
        <span className="overview-bar-share">{share(item.usage.total)}</span>
        {/* Unattributed usage is not a model to compare. */}
        {item.model &&
          fill(index, knownModel(item.usage) / maxModel, rankColor(index))}
      </>
    );
    return (
      <li key={`${item.provider}/${item.model}`}>
        {item.provider && item.model ? (
          <button
            data-slot="overview-button"
            type="button"
            className="overview-bar-row"
            aria-pressed={selected}
            aria-label={t("overview.models.filter", { model: name })}
            onClick={() =>
              onFilter(
                selected
                  ? undefined
                  : {
                      kind: "model",
                      provider: item.provider!,
                      model: item.model!,
                      label: name,
                    },
              )
            }
          >
            {content}
          </button>
        ) : (
          <div className="overview-bar-row">{content}</div>
        )}
      </li>
    );
  };
  const toolRow = (item: Overview["tools"][number], index: number) => (
    <li key={item.name}>
      <div className="overview-bar-row">
        <span className="overview-bar-name">
          <ToolIcon name={item.name} />
          <span className="truncate">
            {t(`overview.tools.names.${item.name}`, {
              defaultValue: item.name,
            })}
          </span>
        </span>
        <span className="overview-bar-value">
          {item.calls.toLocaleString(locale)}
        </span>
        {fill(index, item.calls / maxCalls, rankColor(index))}
      </div>
    </li>
  );
  const selectedGroup =
    filter?.kind === "topic"
      ? filter.topicId
      : filter?.kind === "ids"
        ? filter.id
        : undefined;

  return (
    <div
      className="overview-grid"
      data-side={sideCard || undefined}
      data-stale={stale || undefined}
      // The previous range stays visible but takes no input, keyboard
      // included, until the new one arrives.
      inert={stale || undefined}
    >
      <Card
        area="tokens"
        span={sideCard ? 5 : 7}
        title={t("overview.tokens.title")}
      >
        <div className="overview-hero-row">
          <div className="overview-hero">
            {knownTotal ? formatTokens(shownTokens) : "—"}
          </div>
          <Delta
            current={total}
            previous={previous?.usage.total}
            period={previous}
            format={formatTokens}
          />
          {usage.status === "partial" && (
            <InfoHint
              content={t("overview.partialHint")}
              label={t("overview.partialData")}
            />
          )}
        </div>
        <div className="overview-cost">
          {nonNegative(cost.usd) ? (
            <>
              {t(
                cost.status === "complete"
                  ? "overview.tokens.estimatedCost"
                  : "overview.tokens.estimatedCostAtLeast",
                { cost: formatCost(cost.usd) },
              )}
              {cost.status !== "complete" && (
                <span>{t("overview.tokens.costPartial")}</span>
              )}
            </>
          ) : (
            t("overview.tokens.costUnavailable")
          )}
        </div>
        <div
          className="overview-meter"
          role="img"
          aria-label={`${t("overview.tokens.composition")}: ${SEGMENTS.map(
            (segment) =>
              `${t(segment.label)} ${formatTokens(usage[segment.key])}`,
          ).join(", ")}`}
          data-animate={animate || undefined}
          onMouseLeave={() => setPart(undefined)}
        >
          {blocks.length
            ? blocks.map((segment, index) => (
                <span
                  key={index}
                  data-dim={(part && part !== segment.key) || undefined}
                  style={{
                    background: segment.color,
                    animationDelay: `${index * 14}ms`,
                  }}
                  onMouseEnter={() => setPart(segment.key)}
                />
              ))
            : // No tokens: an unlit meter, like days without activity.
              Array.from({ length: METER }, (_, index) => (
                <span key={index} data-empty="" />
              ))}
        </div>
        <dl className="overview-legend-grid">
          {SEGMENTS.map((segment) => (
            <div
              key={segment.key}
              data-dim={(part && part !== segment.key) || undefined}
              onMouseEnter={() => setPart(segment.key)}
              onMouseLeave={() => setPart(undefined)}
            >
              <dt>
                <i
                  className="overview-swatch"
                  style={{ background: segment.color }}
                />
                {t(segment.label)}
              </dt>
              <dd>
                <b>{formatTokens(usage[segment.key])}</b>
                <span>{share(usage[segment.key])}</span>
              </dd>
            </div>
          ))}
        </dl>
        <dl className="overview-facts">
          <div>
            <dt>{t("overview.tokens.cacheHitRate")}</dt>
            <dd>
              {hit === undefined ? "—" : formatPercent(hit, locale)}
              {points !== undefined && (
                <span>
                  {t("overview.tokens.points", {
                    value: `${points >= 0 ? "+" : "−"}${Math.abs(points)}`,
                  })}
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt>{t("overview.tokens.perRun")}</dt>
            <dd>
              {knownTotal && sessions.runs
                ? formatTokens(total / sessions.runs)
                : "—"}
            </dd>
          </div>
        </dl>
      </Card>

      <Card
        area="sessions"
        span={sideCard ? 3 : 5}
        title={t("overview.sessions.title")}
        actions={
          <Hint content={t("overview.list.viewAll")}>
            <button
              data-slot="overview-button"
              type="button"
              className="overview-icon-button overview-head-icon"
              aria-label={t("overview.list.viewAll")}
              onClick={() =>
                onFilter({ kind: "all", label: t("overview.list.title") })
              }
            >
              <ArrowUpRight aria-hidden="true" />
            </button>
          </Hint>
        }
      >
        <div className="overview-hero-row">
          <div className="overview-hero">{Math.round(shownActive)}</div>
          <Delta
            current={sessions.active}
            previous={previous?.activeConversations}
            period={previous}
            format={String}
          />
        </div>
        {/* Laid out like the Tokens card beside it, so their lines align. */}
        <div className="overview-cost">{stripLabel}</div>
        <div
          className="overview-days"
          aria-hidden="true"
          style={{ gap: strip.length > 14 ? 2 : 3 }}
        >
          {strip.map((item) => (
            <span key={item.key} data-active={item.active} />
          ))}
        </div>
        <dl className="overview-legend-grid">
          <div>
            <dt>{t("overview.sessions.created")}</dt>
            <dd>
              <b>{sessions.created}</b>
            </dd>
          </div>
          <div>
            <dt>{t("overview.sessions.continued")}</dt>
            <dd>
              <b>{sessions.continued}</b>
            </dd>
          </div>
        </dl>
        <dl className="overview-facts">
          <div>
            <dt>{t("overview.sessions.runs")}</dt>
            <dd>{sessions.runs}</dd>
          </div>
          <div>
            <dt>{t("overview.sessions.failedRuns")}</dt>
            <dd>{sessions.failedRuns}</dd>
          </div>
        </dl>
      </Card>

      {summary && (
        <SummaryCard
          view={summary}
          settings={settings}
          locale={locale}
          conversations={summary.state?.conversations ?? sessions.active}
          onGenerate={onGenerate}
          onOpenSetup={onOpenSetup}
          modelName={modelName}
        />
      )}
      {highlight && (
        <Card area="insight" span={4} label={t("overview.insight.label")}>
          {/* Inside the padding box, so the card keeps one neutral outline. */}
          <div className="overview-insight-layer" aria-hidden="true">
            {effect !== "none" && <BackgroundEffect settings={settings} />}
          </div>
          <div className="overview-insight">
            <div className="overview-insight-top">
              <span className="overview-card-title overview-insight-label">
                <Sparkles aria-hidden="true" />
                {t("overview.insight.label")}
              </span>
            </div>
            <div className="overview-insight-figure">
              {share(highlight.tokens)}
              <span>{t("overview.insight.shareOf")}</span>
            </div>
            <h2 data-slot="overview-heading" className="overview-insight-title">
              {topicLabel(highlight, t)}
            </h2>
            <div className="overview-insight-detail">
              {t("overview.insight.conversations", {
                count: highlight.conversationIds.length,
              })}{" "}
              · {t(`overview.topics.sources.${highlight.source}`)}
            </div>
            <div className="overview-insight-action">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  selectGroup({
                    id: highlight.id,
                    label: topicLabel(highlight, t),
                    detail: "",
                    Icon: TOPIC_ICONS[highlight.source],
                    conversationIds: highlight.conversationIds,
                  })
                }
              >
                {t("overview.insight.view", {
                  count: highlight.conversationIds.length,
                })}
                <ChevronRight />
              </Button>
            </div>
          </div>
        </Card>
      )}

      <Card
        area="trend"
        span={7}
        title={t("overview.trend.title")}
        scroll={trendView === "table"}
        actions={
          <>
            <span className="overview-legend">
              <span>
                <i style={{ background: VIZ[2] }} />
                {t("overview.trend.current")}
              </span>
              {previous && (
                <span>
                  <i data-line="dashed" />
                  {t("overview.trend.previous")}
                </span>
              )}
            </span>
            <ViewToggle value={trendView} onChange={onTrendView} />
          </>
        }
      >
        {trendView === "chart" ? (
          <TrendChart
            overview={overview}
            locale={locale}
            animate={animate}
            height={TREND_HEIGHT}
            selectedDay={filter?.kind === "day" ? filter.day : undefined}
            onSelectDay={selectDay}
          />
        ) : (
          <TrendTable overview={overview} locale={locale} />
        )}
      </Card>

      <Card
        area="activity"
        span={5}
        title={t("overview.activity.title")}
        info={t("overview.activity.info")}
        scroll={activityView === "table"}
        actions={
          <>
            <Ramp
              label={t("overview.activity.scale")}
              colors={["var(--overview-track)", ...VIZ]}
            />
            <ViewToggle value={activityView} onChange={onActivityView} />
          </>
        }
      >
        {activityView === "chart" ? (
          <>
            <ActivityHeatmap
              overview={overview}
              weekStart={weekStart}
              locale={locale}
              animate={animate}
            />
            <dl className="overview-facts" data-columns="3">
              <div>
                <dt>{t("overview.activity.peakHour")}</dt>
                <dd>
                  {knownActivity
                    ? t("overview.activity.hourRange", {
                        start: hourLabel(peakHour, locale),
                        end: hourLabel((peakHour + 1) % 24, locale),
                      })
                    : "—"}
                </dd>
              </div>
              <div>
                <dt>{t("overview.activity.peakDay")}</dt>
                <dd>
                  {knownActivity
                    ? weekdayName((peakDay + weekStart) % 7, locale)
                    : "—"}
                </dd>
              </div>
              <div>
                <dt>{t("overview.activity.night")}</dt>
                <dd>
                  {nightRuns}
                  <span>
                    {t("overview.activity.runsUnit", { count: nightRuns })}
                  </span>
                </dd>
              </div>
            </dl>
          </>
        ) : (
          <ActivityTable
            overview={overview}
            weekStart={weekStart}
            locale={locale}
          />
        )}
      </Card>

      {groups.length > 0 && (
        <Card
          area="topics"
          span={12}
          title={t("overview.topics.title")}
          info={
            aiGroups.length
              ? t("overview.topics.aiInfo")
              : t("overview.topics.info")
          }
          // Each area lists its conversations most tokens first, so the key
          // reads the same way.
          actions={
            <Ramp
              label={t("overview.topics.scale")}
              colors={[...VIZ].reverse()}
            />
          }
        >
          <TopicDots
            overview={overview}
            groups={groups}
            selected={selectedGroup}
            onSelect={selectGroup}
            locale={locale}
            animate={animate}
            conversationTitle={conversationTitle}
          />
        </Card>
      )}

      <Card
        area="models"
        span={6}
        title={t("overview.models.title")}
        info={t("overview.models.info")}
        scroll
      >
        {overview.models.length ? (
          <div className="overview-bars-table" data-table="models">
            <div className="overview-bars-columns" aria-hidden="true">
              <span>{t("overview.models.columns.model")}</span>
              <span data-column="runs">
                {t("overview.models.columns.runs")}
              </span>
              <span>{t("overview.models.columns.tokens")}</span>
              <span>{t("overview.models.columns.share")}</span>
            </div>
            <ul className="overview-bars">
              {overview.models.map((item, index) =>
                item.model ? modelRow(item, index) : null,
              )}
            </ul>
            {overview.models
              .filter((item) => !item.model)
              .map((item) => (
                <div
                  className="overview-model-footer"
                  key={`${item.provider}/${item.model}`}
                >
                  <div className="overview-bar-row">
                    <span className="overview-bar-name">
                      <span className="truncate">
                        {t("overview.models.unattributed")}
                      </span>
                    </span>
                    <span data-column="runs" />
                    <span className="overview-bar-value">
                      <TokenCount usage={item.usage} />
                    </span>
                    <span className="overview-bar-share">
                      {share(item.usage.total)}
                    </span>
                  </div>
                </div>
              ))}
          </div>
        ) : (
          <div className="overview-empty-text">
            {t("overview.models.empty")}
          </div>
        )}
      </Card>

      <Card area="tools" span={6} title={t("overview.tools.title")} scroll>
        {overview.tools.length ? (
          <div className="overview-tool-groups">
            {(
              [
                ["connectors", connectorTools],
                ["builtIn", builtInTools],
              ] as const
            )
              .filter(([, items]) => items.length)
              .map(([key, items]) => (
                <section
                  key={key}
                  className="overview-bars-table"
                  data-table="tools"
                  aria-label={t(`overview.tools.${key}`)}
                >
                  <div className="overview-bars-columns">
                    <h3 className="overview-bars-heading">
                      {t(`overview.tools.${key}`)}
                    </h3>
                    <span aria-hidden="true">
                      {t("overview.tools.columns.calls")}
                    </span>
                  </div>
                  <ul className="overview-bars">{items.map(toolRow)}</ul>
                </section>
              ))}
          </div>
        ) : (
          <div className="overview-empty-text">{t("overview.tools.empty")}</div>
        )}
      </Card>

      {filter && (
        <ConversationDrawer
          overview={overview}
          filter={filter}
          onClose={() => onFilter(undefined)}
          onOpen={onOpenConversation}
          conversationTitle={conversationTitle}
          modelName={modelName}
          groups={groups}
        />
      )}
    </div>
  );
}
