import { Hint } from "@/components/ui/tooltip";
import { Tabs } from "@base-ui/react/tabs";
import { ProviderIcon } from "./ProviderIcon";
import { Gauge, Clock3 } from "lucide-react";
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
  const percentText = contextKnown
    ? `${context!.percent!.toFixed(1).replace(/\.0$/, "")}%`
    : "—";
  const modelLabel = `${modelName ?? "—"}${metadata ? ` · ${metadata.thinking[0].toUpperCase()}${metadata.thinking.slice(1)}` : ""}`;
  const segments = breakdown.filter(([field]) => field !== "reasoning");
  const compositionKnown =
    conversation?.status === "complete" &&
    segments.every(([field]) => nonNegative(conversation?.[field]));
  const compositionTotal = segments.reduce(
    (sum, [field]) => sum + (conversation?.[field] ?? 0),
    0,
  );
  const providerLabel =
    provider?.name ??
    metadata?.provider ??
    t("Provider unavailable", "服务商不可用");
  return (
    <div className="usage-header" data-testid="usage-header">
      <Popover>
        <Hint content={`${t("Context usage", "上下文占用")} · ${contextKnown ? percentText : t("Unavailable", "暂不可用")}`}>
        <PopoverTrigger
          className="usage-trigger"
          aria-label={t("Open current usage details", "打开当前用量详情")}
        >
          <Gauge size={16} strokeWidth={1.5} aria-hidden="true" />
          <span>{percentText}</span>
        </PopoverTrigger>
        </Hint>
        <PopoverContent
          className="usage-popover"
          sideOffset={10}
          align="end"
          aria-label={t("Usage details", "用量详情")}
        >
          <Tabs.Root defaultValue="overview" className="usage-tabs">
            <div className="usage-heading">
              <h2 data-slot="usage-title">{t("Usage", "用量")}</h2>
              <Tabs.List
                activateOnFocus
                className="usage-tab-list"
                aria-label={t("Usage view", "用量视图")}
              >
                <Tabs.Tab data-slot="usage-tab" value="overview">{t("Overview", "概览")}</Tabs.Tab>
                <Tabs.Tab data-slot="usage-tab" value="details">{t("Details", "明细")}</Tabs.Tab>
              </Tabs.List>
            </div>
            <Tabs.Panel value="overview" className="usage-tab-panel">
              <div className="usage-context" data-known={contextKnown}>
                <div className="usage-context-labels">
                  <span>{t("Context", "上下文")}</span>
                  <strong>{percentText}</strong>
                </div>
                <div
                  className="usage-progress"
                  role={contextKnown ? "progressbar" : undefined}
                  aria-label={t("Context usage", "上下文占用")}
                  aria-valuemin={contextKnown ? 0 : undefined}
                  aria-valuemax={contextKnown ? 100 : undefined}
                  aria-valuenow={contextKnown ? percent : undefined}
                >
                  <span style={{ width: `${percent}%` }} />
                </div>
                <p>
                  {contextKnown
                    ? `${formatTokens(context!.tokens)} / ${formatTokens(context!.contextWindow)} tokens`
                    : `${t("Unavailable", "暂不可用")}${nonNegative(context?.contextWindow) ? ` / ${formatTokens(context.contextWindow)}` : ""}`}
                </p>
              </div>
              <table className="usage-summary">
                <thead>
                  <tr>
                    <th aria-label={t("Scope", "范围")} />
                    <th>Tokens</th>
                    <th>{t("Cost", "费用")}</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    [
                      active
                        ? t("Current run", "当前运行")
                        : t("Last run", "最近一轮"),
                      run,
                      "run-usage",
                    ],
                    [
                      t("Conversation", "整个会话"),
                      conversation,
                      "conversation-usage",
                    ],
                  ].map(([label, value, testId]) => {
                    const item = value as TokenUsage | undefined;
                    return (
                      <tr key={String(testId)} data-testid={String(testId)}>
                        <th scope="row">{String(label)}</th>
                        <td>
                          {item?.status === "partial" ? <Hint content={t("Partial token data", "Token 数据不完整")}><span tabIndex={0}>{tokens(item)}</span></Hint> : tokens(item)}
                        </td>
                        <td>
                          <Hint content={cost(item?.cost)}><span tabIndex={0}>
                          {nonNegative(item?.cost.usd) && item?.cost.status !== "unavailable"
                            ? `${formatCost(item.cost.usd, true)}${item.cost.source === "provider" ? "" : " ≈"}${item.cost.status === "partial" ? "+" : ""}`
                            : "—"}
                          </span></Hint>
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
                  ? ` · ${t("Partial data", "Token 数据不完整")}`
                  : ""}
              </p>
              <Hint content={`${modelLabel} · ${providerLabel}`}><div className="usage-model" tabIndex={0}>
                <ProviderIcon provider={metadata?.provider ?? ""} />
                <strong>{modelLabel}</strong>
              </div></Hint>
            </Tabs.Panel>
            <Tabs.Panel value="details" className="usage-tab-panel">
              <div className="usage-breakdown">
                <div className="usage-breakdown-heading">
                  <span>{t("Conversation tokens", "会话 Token")}</span>
                  <strong>{tokens(conversation)}</strong>
                </div>
                <div
                  className="usage-composition"
                  role="img"
                  aria-label={
                    compositionKnown
                      ? segments
                          .map(
                            ([field, label]) =>
                              `${label}: ${formatTokens(conversation?.[field])}`,
                          )
                          .join(", ")
                      : t("Token composition unavailable", "Token 组成暂不可用")
                  }
                >
                  {compositionKnown &&
                    compositionTotal > 0 &&
                    segments.map(([field]) => (
                      <span
                        key={field}
                        data-kind={field}
                        style={{
                          width: `${((conversation?.[field] ?? 0) / compositionTotal) * 100}%`,
                        }}
                      />
                    ))}
                </div>
                <dl>
                  {segments.map(([field, label]) => (
                    <div key={field}>
                      <dt>
                        <i data-kind={field} aria-hidden="true" />
                        {label}
                      </dt>
                      <dd>{formatTokens(conversation?.[field])}</dd>
                    </div>
                  ))}
                </dl>
                {nonNegative(conversation?.reasoning) && (
                  <p className="usage-reasoning">
                    {t("Reasoning · part of output", "推理 · 包含在输出中")}
                    <span>{formatTokens(conversation.reasoning)}</span>
                  </p>
                )}
              </div>
              <Hint content={totalTitle}><div
                className="usage-total"
                tabIndex={0}
                aria-label={`${t("All models total", "所有模型累计")} ${formatTokens(global?.totalTokens)} tokens · ${totalTitle}`}
              >
                <span>{t("All models total", "所有模型累计")}</span>
                <strong>
                  {formatTokens(global?.totalTokens)}
                  {global?.status === "partial" &&
                  nonNegative(global.totalTokens)
                    ? "+"
                    : ""}
                </strong>
                <span>tokens</span>
              </div></Hint>
            </Tabs.Panel>
          </Tabs.Root>
        </PopoverContent>
      </Popover>
    </div>
  );
}
