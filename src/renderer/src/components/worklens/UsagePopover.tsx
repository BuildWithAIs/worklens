import { ChevronDown } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useLocale } from "@/lib/locale";
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
import "./usage.css";

export function UsagePopover({
  global,
  usage,
  selection,
  providers,
}: {
  global?: GlobalUsage;
  usage?: UsageSnapshot;
  selection?: Selection;
  providers: ProviderInfo[];
}) {
  const { t } = useLocale();
  const run = usage?.run;
  const conversation = usage?.conversation;
  const context = usage?.context;
  const active = run?.state === "active";
  const tokens = (value?: TokenUsage) =>
    `${formatTokens(value?.total)}${value?.status === "partial" && nonNegative(value.total) ? "+" : ""}`;
  const cost = (value?: CostUsage) => {
    if (!value || value.status === "unavailable" || !nonNegative(value.usd))
      return t("Cost unavailable", "费用不可用");
    const source =
      value.source === "provider"
        ? t("reported", "已报告")
        : t("estimated", "估算");
    return `${formatCost(value.usd, true)} ${value.status === "partial" ? t("partial · ", "部分 · ") : ""}${source}`;
  };
  const state = run
    ? {
        active: t("In progress", "运行中"),
        completed: t("Completed", "已完成"),
        cancelled: t("Cancelled", "已取消"),
        failed: t("Failed", "失败"),
        incomplete: t("Incomplete", "未完整结束"),
      }[run.state]
    : t("No recorded run", "没有可归因的运行记录");
  const totalTitle =
    t("All retained local sessions", "所有保留的本地会话") +
    (global?.status === "partial"
      ? t(" · Partial data", " · 数据不完整")
      : global?.status !== "complete"
        ? t(" · Usage unavailable", " · 用量不可用")
        : "");
  const metadata = run?.selection ?? selection;
  const provider = providers.find((item) => item.id === metadata?.provider);
  const modelName =
    provider?.models.find((item) => item.id === metadata?.model)?.name ??
    metadata?.model;
  const contextKnown =
    context?.status !== "unavailable" &&
    nonNegative(context?.tokens) &&
    nonNegative(context?.percent) &&
    nonNegative(context?.contextWindow);
  const percent = contextKnown ? Math.min(100, context!.percent!) : 0;
  const breakdown = [
    ["input", t("Input", "输入")],
    ["output", t("Output", "输出")],
    ["cacheRead", t("Cache read", "缓存读取")],
    ["cacheWrite", t("Cache write", "缓存写入")],
    ...(nonNegative(conversation?.reasoning)
      ? [["reasoning", t("Reasoning · part of output", "推理 · 包含在输出中")]]
      : []),
  ] as [
    keyof Pick<
      TokenUsage,
      "input" | "output" | "cacheRead" | "cacheWrite" | "reasoning"
    >,
    string,
  ][];
  return (
    <div className="usage-header" data-testid="usage-header">
      <div
        className="usage-total"
        title={totalTitle}
        aria-label={`${t("Total", "总用量")} ${formatTokens(global?.totalTokens)}. ${totalTitle}`}
      >
        <span>{t("Total", "总用量")}</span>
        <strong>
          {formatTokens(global?.totalTokens)}
          {global?.status === "partial" && nonNegative(global.totalTokens)
            ? "+"
            : ""}
        </strong>
        <span>tokens</span>
      </div>
      <Popover>
        <PopoverTrigger
          className="usage-trigger"
          aria-label={t("Open current usage details", "打开当前用量详情")}
        >
          {active && (
            <span
              className="usage-live-dot"
              aria-label={t("Run active", "运行中")}
            />
          )}
          <span className="usage-current-label">{t("Current", "当前")}</span>
          <strong>
            {tokens(run)}
            {nonNegative(run?.total) ? " tokens" : ""}
          </strong>
          {run?.cost.status === "complete" && nonNegative(run.cost.usd) && (
            <>
              <span className="usage-separator">·</span>
              <strong className="usage-chip-cost">
                {formatCost(run.cost.usd)} {t("est.", "估算")}
              </strong>
            </>
          )}
          <ChevronDown size={12} aria-hidden="true" />
        </PopoverTrigger>
        <PopoverContent
          className="usage-popover"
          sideOffset={10}
          aria-label={t("Usage details", "用量详情")}
        >
          <div className="usage-popover-heading">
            <h2 data-slot="usage-title">{t("Usage", "用量")}</h2>
            <p>
              {t(
                "Current conversation · live local accounting",
                "当前会话 · 本地实时统计",
              )}
            </p>
          </div>
          <div className="usage-popover-body">
            <div className="usage-summary-grid">
              <div className="usage-summary-card" data-testid="run-usage">
                <h3 data-slot="usage-label">
                  {active
                    ? t("Current run", "当前运行")
                    : t("Last run", "最近一轮")}
                </h3>
                <strong className="usage-summary-number">{tokens(run)}</strong>
                <p>{cost(run?.cost)}</p>
                <p className="usage-run-state">
                  {state}
                  {nonNegative(run?.elapsedMs)
                    ? ` · ${(run.elapsedMs / 1000).toFixed(1)}s`
                    : ""}
                </p>
                {run?.status === "partial" && (
                  <p>{t("Partial token data", "Token 数据不完整")}</p>
                )}
              </div>
              <div
                className="usage-summary-card"
                data-testid="conversation-usage"
              >
                <h3 data-slot="usage-label">{t("Conversation", "整个会话")}</h3>
                <strong className="usage-summary-number">
                  {tokens(conversation)}
                </strong>
                <p>{cost(conversation?.cost)}</p>
                {conversation?.status === "partial" && (
                  <p>{t("Partial token data", "Token 数据不完整")}</p>
                )}
              </div>
            </div>
            <div className="usage-context">
              <div className="usage-context-labels">
                <div>
                  <h3 data-slot="usage-label">{t("Context", "上下文")}</h3>
                  <p>
                    {t("Current active model context", "当前所选模型的上下文")}
                  </p>
                </div>
                <div className="usage-context-values">
                  <strong>
                    {contextKnown
                      ? `${formatTokens(context!.tokens)} / ${formatTokens(context!.contextWindow)}`
                      : `—${nonNegative(context?.contextWindow) ? ` / ${formatTokens(context.contextWindow)}` : ""}`}
                  </strong>
                  <p>
                    {contextKnown
                      ? `${context!.percent!.toFixed(1).replace(/\.0$/, "")}%`
                      : t("Unavailable", "暂不可用")}
                  </p>
                </div>
              </div>
              <div
                className="usage-progress"
                role={contextKnown ? "progressbar" : undefined}
                aria-label={t("Context usage", "上下文占用")}
                aria-valuemin={contextKnown ? 0 : undefined}
                aria-valuemax={contextKnown ? 100 : undefined}
                aria-valuenow={contextKnown ? percent : undefined}
                aria-valuetext={
                  contextKnown
                    ? `${context!.tokens} / ${context!.contextWindow} tokens (${context!.percent!.toFixed(1)}%)`
                    : undefined
                }
              >
                <span style={{ width: `${percent}%` }} />
              </div>
            </div>
            <div className="usage-breakdown">
              <div className="usage-breakdown-heading">
                <h3 data-slot="usage-label">
                  {t("Token breakdown", "Token 明细")}
                </h3>
                <span>{t("conversation", "整个会话")}</span>
              </div>
              <dl>
                {breakdown.map(([field, label]) => (
                  <div key={field}>
                    <dt>{label}</dt>
                    <dd>{formatTokens(conversation?.[field])}</dd>
                  </div>
                ))}
              </dl>
            </div>
            <div className="usage-model">
              <span>
                {t("Model", "模型")}
                {run?.selection ? ` · ${t("run selection", "本轮所用")}` : ""}
              </span>
              <strong>
                {modelName ?? "—"}
                {metadata
                  ? ` · ${metadata.thinking[0].toUpperCase()}${metadata.thinking.slice(1)}`
                  : ""}
              </strong>
              <span>
                {provider?.name ??
                  metadata?.provider ??
                  t("Provider unavailable", "服务商不可用")}
              </span>
            </div>
            <p className="usage-cost-note">
              {t(
                "Estimated cost is derived from model usage. Provider billing may differ.",
                "费用根据模型用量估算，可能与服务商实际账单不同。",
              )}
            </p>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
