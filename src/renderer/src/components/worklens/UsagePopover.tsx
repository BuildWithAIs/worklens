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
  const { t } = useAppTranslation();
  // Hovering a segment or legend entry highlights that category.
  const [highlighted, setHighlighted] = useState<string>();
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
          <Tabs.Root defaultValue="overview" className="usage-tabs">
            <div className="usage-heading">
              <h2 data-slot="usage-title">{t("usage.usage")}</h2>
              <Tabs.List
                activateOnFocus
                className="usage-tab-list"
                aria-label={t("usage.usageView")}
              >
                <Tabs.Tab data-slot="usage-tab" value="overview">
                  {t("usage.overview")}
                </Tabs.Tab>
                <Tabs.Tab data-slot="usage-tab" value="details">
                  {t("usage.details")}
                </Tabs.Tab>
                <Tabs.Indicator className="usage-tab-indicator" />
              </Tabs.List>
            </div>
            <Tabs.Panel value="overview" className="usage-tab-panel">
              <div className="usage-context" data-known={contextKnown}>
                <div className="usage-context-labels">
                  <span>{t("usage.context")}</span>
                  <span>
                    {contextKnown
                      ? `${approximate}${formatTokens(shownTokens)} / ${formatTokens(totals.window)} · `
                      : ""}
                    <strong>
                      {compacting ? t("usage.compacting") : percentText}
                    </strong>
                  </span>
                </div>
                <ContextBar
                  context={context}
                  compacting={compacting}
                  size="full"
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
                    marker={
                      nonNegative(context?.compactAt)
                        ? {
                            label: t("usage.autoCompact"),
                            value: formatTokens(context.compactAt),
                          }
                        : undefined
                    }
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
              <table className="usage-summary">
                <thead>
                  <tr>
                    <th aria-label={t("usage.scope")} />
                    <th>Tokens</th>
                    <th>{t("usage.cost")}</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    [
                      active ? t("usage.currentRun") : t("usage.lastRun"),
                      run,
                      "run-usage",
                    ],
                    [
                      t("usage.conversation"),
                      conversation,
                      "conversation-usage",
                    ],
                  ].map(([label, value, testId]) => {
                    const item = value as TokenUsage | undefined;
                    return (
                      <tr key={String(testId)} data-testid={String(testId)}>
                        <th scope="row">{String(label)}</th>
                        <td>
                          <span
                            aria-label={
                              item?.status === "partial"
                                ? `${tokens(item)} · ${t("usage.partialTokenData")}`
                                : undefined
                            }
                          >
                            {tokens(item)}
                          </span>
                        </td>
                        <td>
                          <span aria-label={cost(item?.cost)}>
                            {nonNegative(item?.cost.usd) &&
                            item?.cost.status !== "unavailable"
                              ? `${formatCost(item.cost.usd, true)}${item.cost.source === "provider" ? "" : " ≈"}${item.cost.status === "partial" ? "+" : ""}`
                              : "—"}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="usage-run-state usage-notice">
                <Clock3 size={12} aria-hidden="true" />
                {state}
                {nonNegative(run?.elapsedMs)
                  ? ` · ${(run.elapsedMs / 1000).toFixed(1)}s`
                  : ""}
                {run?.status === "partial"
                  ? ` · ${t("usage.partialData")}`
                  : ""}
              </p>
              <div
                className="usage-model"
                aria-label={`${modelLabel} · ${providerLabel}`}
              >
                <ProviderIcon provider={metadata?.provider ?? ""} />
                <strong>{modelLabel}</strong>
              </div>
            </Tabs.Panel>
            <Tabs.Panel value="details" className="usage-tab-panel">
              <div className="usage-breakdown">
                <div className="usage-breakdown-heading">
                  <span>{t("usage.conversationTokens")}</span>
                  <strong>{tokens(conversation)}</strong>
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
                {nonNegative(cacheHit) && (
                  <p className="usage-cache" data-testid="cache-usage">
                    {t("usage.cacheHit", {
                      percent: Math.round(cacheHit),
                    })}
                    {nonNegative(usage?.cacheSavingsUsd) &&
                    usage.cacheSavingsUsd > 0
                      ? ` · ${t("usage.cacheSaved", { cost: formatCost(usage.cacheSavingsUsd, true) })}`
                      : ""}
                  </p>
                )}
                {nonNegative(conversation?.reasoning) && (
                  <p className="usage-reasoning">
                    {t("usage.reasoningPartOfOutput")}
                    <span>{formatTokens(conversation.reasoning)}</span>
                  </p>
                )}
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
