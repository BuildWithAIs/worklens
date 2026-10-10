import { Hint } from "@/components/ui/tooltip";
import { Tabs } from "@base-ui/react/tabs";
import { ProviderIcon } from "./ProviderIcon";
import { Clock3, Info, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useAppTranslation } from "@/i18n";
import { formatCost, formatTokens } from "@/lib/usage-format";
import { formatDuration } from "@/lib/duration";
import { nonNegative } from "../../../../shared/usage";
import type {
  CostUsage,
  GlobalUsage,
  ProviderInfo,
  Selection,
  TokenUsage,
  UsageSnapshot,
} from "../../../../shared/contracts";
import { useState } from "react";
import {
  ContextBar,
  SegmentTrack,
  UsageLegend,
  contextTotals,
  useAnimatedNumber,
} from "./ContextBar";
import "./usage.css";

export function UsagePopover({
  global,
  usage,
  selection,
  providers,
  compacting = false,
}: {
  global?: GlobalUsage;
  usage?: UsageSnapshot;
  selection?: Selection;
  providers: ProviderInfo[];
  /** Pi is summarizing the conversation to free context. */
  compacting?: boolean;
}) {
  const { t, language } = useAppTranslation();
  // Hovering a segment or legend entry highlights that category.
  const [highlighted, setHighlighted] = useState<string>();
  // Both panels stay mounted in one grid cell so the tabs share a height.
  // The inactive one keeps its space (and inert) instead of Tailwind's
  // display: none for [hidden].
  const inactivePanel = ({
    hidden,
    ...props
  }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props} data-inactive={hidden || undefined} />
  );
  const run = usage?.run;
  const conversation = usage?.conversation;
  const context = usage?.context;
  const active = run?.state === "active";
  const tokens = (value?: TokenUsage) =>
    `${formatTokens(value?.total)}${value?.status === "partial" && nonNegative(value.total) ? "+" : ""}`;
  const cost = (value?: CostUsage) => {
    if (!value || value.status === "unavailable" || !nonNegative(value.usd))
      return t("usage.costUnavailable");
    const source =
      value.source === "provider" ? t("usage.reported") : t("usage.estimated");
    return `${formatCost(value.usd, true)} ${value.status === "partial" ? t("usage.partial") : ""}${source}`;
  };
  const state = run
    ? {
        active: t("usage.inProgress"),
        completed: t("usage.completed"),
        cancelled: t("usage.cancelled"),
        failed: t("common.failed"),
        incomplete: t("usage.incomplete"),
      }[run.state]
    : t("usage.noRecordedRun");
  const totalTitle =
    t("usage.allRetainedLocalSessions") +
    (global?.status === "partial"
      ? t("usage.partialDataSuffix")
      : global?.status !== "complete"
        ? t("usage.usageUnavailableSuffix")
        : "");
  const metadata = run?.selection ?? selection;
  const provider = providers.find((item) => item.id === metadata?.provider);
  const modelName =
    provider?.models.find((item) => item.id === metadata?.model)?.name ??
    metadata?.model;
  // Right after compaction Pi cannot report the size yet; segments then carry
  // an estimate, shown with "≈" until the next response reports it.
  const totals = contextTotals(context);
  const contextKnown = nonNegative(totals.tokens) && nonNegative(totals.window);
  const shownTokens = useAnimatedNumber(totals.tokens);
  const shownPercent = useAnimatedNumber(totals.percent);
  const approximate = totals.estimated ? "≈" : "";
  const breakdown = [
    ["input", t("usage.input")],
    ["output", t("usage.output")],
    ["cacheRead", t("usage.cacheRead")],
    ["cacheWrite", t("usage.cacheWrite")],
    ...(nonNegative(conversation?.reasoning)
      ? [["reasoning", t("usage.reasoningPartOfOutput")]]
      : []),
  ] as [
    keyof Pick<
      TokenUsage,
      "input" | "output" | "cacheRead" | "cacheWrite" | "reasoning"
    >,
    string,
  ][];
  const percentText =
    contextKnown && nonNegative(shownPercent)
      ? `${approximate}${shownPercent.toFixed(1).replace(/\.0$/, "")}%`
      : "—";
  const kinds = (["system", "summary", "history", "turn"] as const).flatMap(
    (kind) => {
      const tokens = (context?.segments ?? [])
        .filter((segment) => segment.kind === kind)
        .reduce((sum, segment) => sum + segment.tokens, 0);
      return tokens > 0 ? [{ kind, tokens }] : [];
    },
  );
  const cacheInput =
    nonNegative(conversation?.input) &&
    nonNegative(conversation?.cacheRead) &&
    nonNegative(conversation?.cacheWrite)
      ? conversation.input + conversation.cacheRead + conversation.cacheWrite
      : 0;
  const cacheHit =
    cacheInput > 0 ? (conversation!.cacheRead! / cacheInput) * 100 : undefined;
  const modelLabel = `${modelName ?? "—"}${metadata ? ` · ${metadata.thinking[0].toUpperCase()}${metadata.thinking.slice(1)}` : ""}`;
  const segments = breakdown.filter(([field]) => field !== "reasoning");
  // Requests without accounting (e.g. stopped mid-stream) make the totals a
  // lower bound. The known requests still show their composition, marked "+".
  const compositionKnown = segments.every(([field]) =>
    nonNegative(conversation?.[field]),
  );
  const compositionPartial = conversation?.status === "partial";
  const compositionTotal = segments.reduce(
    (sum, [field]) => sum + (conversation?.[field] ?? 0),
    0,
  );
  // Running and completed runs need no note; other states and incomplete
  // data are named in the run's row, so no extra line is needed.
  const runNotice = [
    !run || !["active", "completed"].includes(run.state) ? state : undefined,
    run?.status === "partial" ? t("usage.partialData") : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const duration = nonNegative(run?.elapsedMs)
    ? formatDuration(run.elapsedMs, language, true)
    : undefined;
  // "≈" marks estimates; "+" marks totals missing some requests.
  const costText = (item?: TokenUsage) =>
    nonNegative(item?.cost.usd) && item?.cost.status !== "unavailable"
      ? `${item.cost.source === "provider" ? "" : "≈ "}${formatCost(item.cost.usd, true)}${item.cost.status === "partial" ? "+" : ""}`
      : "—";
  const runLabel = active ? t("usage.currentRun") : t("usage.lastRun");
  // One plain sentence on the dashed threshold marker, shown on hover and
  // read with the bar; the header already shows usage and window size.
  const compactAt = context?.compactAt;
  const thresholdHint =
    nonNegative(compactAt) && nonNegative(totals.window) && totals.window > 0
      ? nonNegative(totals.tokens) && totals.tokens >= compactAt
        ? t("usage.compactsNext")
        : t("usage.compactsAtDetail", {
            tokens: formatTokens(compactAt),
            percent: Math.round((compactAt / totals.window) * 100),
          })
      : undefined;
  const providerLabel =
    provider?.name ?? metadata?.provider ?? t("usage.providerUnavailable");
  return (
    <div className="usage-header" data-testid="usage-header">
      <Popover>
        <PopoverTrigger
          render={<Button variant="ghost" size="sm" />}
          className="usage-trigger"
          data-near={totals.near || undefined}
          aria-label={t("usage.openCurrentUsageDetails")}
        >
          <ContextBar context={context} compacting={compacting} size="mini" />
          <span>{compacting ? t("usage.compacting") : percentText}</span>
          <ChevronDown
            data-icon="inline-end"
            className="size-3"
            aria-hidden="true"
          />
        </PopoverTrigger>
        <PopoverContent
          className="usage-popover"
          sideOffset={10}
          align="end"
          aria-label={t("usage.usageDetails")}
        >
          <Tabs.Root defaultValue="context" className="usage-tabs">
            <div className="usage-heading">
              <Tabs.List
                activateOnFocus
                className="usage-tab-list"
                aria-label={t("usage.usageView")}
              >
                <Tabs.Tab data-slot="usage-tab" value="context">
                  {t("usage.context")}
                </Tabs.Tab>
                <Tabs.Tab data-slot="usage-tab" value="usage">
                  {t("usage.usage")}
                </Tabs.Tab>
                <Tabs.Indicator className="usage-tab-indicator" />
              </Tabs.List>
            </div>
            {/* Context: what fills the window now and when it compacts. */}
            <Tabs.Panel
              value="context"
              className="usage-tab-panel"
              keepMounted
              render={inactivePanel}
            >
              <div className="usage-context" data-known={contextKnown}>
                {/* The tab names the subject, so the share of the window leads. */}
                <div className="usage-context-labels">
                  <strong>
                    {compacting ? t("usage.compacting") : percentText}
                  </strong>
                  <span>
                    {contextKnown
                      ? `${approximate}${formatTokens(shownTokens)} / ${formatTokens(totals.window)}`
                      : ""}
                  </span>
                </div>
                <ContextBar
                  context={context}
                  compacting={compacting}
                  size="full"
                  thresholdHint={thresholdHint}
                  active={highlighted}
                  onActive={setHighlighted}
                />
                {kinds.length > 0 ? (
                  <UsageLegend
                    items={kinds.map(({ kind, tokens }) => ({
                      kind,
                      label: t(`usage.segmentsShort.${kind}`),
                      description: t(`usage.segments.${kind}`),
                      value: formatTokens(tokens),
                    }))}
                    active={highlighted}
                    onActive={setHighlighted}
                  />
                ) : (
                  !contextKnown && (
                    <p>
                      {`${t("usage.unavailable")}${nonNegative(context?.contextWindow) ? ` / ${formatTokens(context.contextWindow)}` : ""}`}
                    </p>
                  )
                )}
              </div>
              {/* How much of the resent context the provider served from cache. */}
              {nonNegative(cacheHit) && (
                <dl className="usage-facts usage-context-facts">
                  <div data-testid="cache-usage">
                    <dt>{t("usage.cacheHitRate")}</dt>
                    <dd>{Math.round(cacheHit)}%</dd>
                  </div>
                </dl>
              )}
              {/* The run's model and how long it took, like the details footer:
                  label on the left, value on the right. */}
              <div
                className="usage-model"
                aria-label={`${modelLabel} · ${providerLabel}${duration ? ` · ${duration}` : ""}`}
              >
                <ProviderIcon provider={metadata?.provider ?? ""} />
                <strong>{modelLabel}</strong>
                {duration && (
                  <span className="usage-duration" data-testid="run-duration">
                    <Clock3 size={12} aria-hidden="true" />
                    {duration}
                  </span>
                )}
              </div>
            </Tabs.Panel>
            {/* Spend: what was used, what it cost and where it went; each row
                names its own scope. */}
            <Tabs.Panel
              value="usage"
              className="usage-tab-panel"
              keepMounted
              render={inactivePanel}
            >
              <div className="usage-breakdown">
                {/* Mirrors the context tab: headline value, its composition,
                    then details. Each line names its own scope. */}
                <div
                  className="usage-context-labels"
                  data-testid="conversation-usage"
                >
                  <span
                    aria-label={`${tokens(conversation)} · ${t("usage.conversation")}${conversation?.status === "partial" ? ` · ${t("usage.partialTokenData")}` : ""}`}
                  >
                    <strong>{tokens(conversation)}</strong>
                    <span className="usage-scope">
                      {` · ${t("usage.conversation")}`}
                    </span>
                  </span>
                  <span aria-label={cost(conversation?.cost)}>
                    {costText(conversation)}
                  </span>
                </div>
                <div
                  className="usage-context-bar"
                  data-size="full"
                  role="img"
                  aria-label={
                    compositionKnown
                      ? segments
                          .map(
                            ([field, label]) =>
                              `${label}: ${formatTokens(conversation?.[field])}`,
                          )
                          .join(", ") +
                        (compositionPartial
                          ? ` · ${t("usage.partialTokenData")}`
                          : "")
                      : t("usage.tokenCompositionUnavailable")
                  }
                >
                  <SegmentTrack
                    className="usage-composition"
                    segments={
                      compositionKnown && compositionTotal > 0
                        ? segments.map(([field]) => ({
                            id: field,
                            kind: field,
                            percent:
                              ((conversation?.[field] ?? 0) /
                                compositionTotal) *
                              100,
                          }))
                        : []
                    }
                    active={highlighted}
                    onActive={setHighlighted}
                  />
                </div>
                <UsageLegend
                  items={segments.map(([field, label]) => ({
                    kind: field,
                    label,
                    description: label,
                    value:
                      formatTokens(conversation?.[field]) +
                      (compositionPartial && nonNegative(conversation?.[field])
                        ? "+"
                        : ""),
                  }))}
                  active={highlighted}
                  onActive={setHighlighted}
                />
                <dl className="usage-facts">
                  <div
                    data-testid="run-usage"
                    aria-label={[
                      runLabel,
                      state,
                      runNotice,
                      run && tokens(run),
                      run && costText(run),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  >
                    <dt>
                      {runLabel}
                      {/* A second line, so a long state never wraps
                            mid-sentence after the label. */}
                      {runNotice && (
                        <span className="usage-run-state usage-notice">
                          {runNotice}
                        </span>
                      )}
                    </dt>
                    <dd>{run ? `${tokens(run)} · ${costText(run)}` : "—"}</dd>
                  </div>
                  {nonNegative(usage?.cacheSavingsUsd) &&
                    usage.cacheSavingsUsd > 0 && (
                      <div data-testid="cache-savings">
                        <dt>{t("usage.cacheSavedLabel")}</dt>
                        <dd>≈ {formatCost(usage.cacheSavingsUsd, true)}</dd>
                      </div>
                    )}
                  {nonNegative(conversation?.reasoning) && (
                    <div className="usage-reasoning">
                      <dt>{t("usage.reasoningPartOfOutput")}</dt>
                      <dd>{formatTokens(conversation.reasoning)}</dd>
                    </div>
                  )}
                </dl>
              </div>
              <div
                className="usage-total"
                aria-label={`${t("usage.allModelsTotal")} ${formatTokens(global?.totalTokens)} tokens · ${totalTitle}`}
              >
                <span className="usage-total-label">
                  {t("usage.allModelsTotal")}
                  <Hint content={totalTitle}>
                    <Button
                      variant="hint"
                      size="icon-xs"
                      className="size-5"
                      aria-label={t("usage.aboutTotalUsage")}
                    >
                      <Info aria-hidden="true" />
                    </Button>
                  </Hint>
                </span>
                <strong>
                  {formatTokens(global?.totalTokens)}
                  {global?.status === "partial" &&
                  nonNegative(global.totalTokens)
                    ? "+"
                    : ""}
                </strong>
                <span>tokens</span>
              </div>
            </Tabs.Panel>
          </Tabs.Root>
        </PopoverContent>
      </Popover>
    </div>
  );
}
