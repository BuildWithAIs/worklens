import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  SessionManager,
  calculateContextTokens,
  estimateTokens,
  getLastAssistantUsage,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type {
  ContextUsage,
  GlobalUsage,
  RunUsage,
  Selection,
  TokenUsage,
} from "../shared/contracts";
import { nonNegative, unavailableUsage } from "../shared/usage";

type PriceModel = {
  contextWindow?: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
};
export type ModelLookup = (
  provider: string,
  model: string,
) => PriceModel | undefined;
const fields = ["input", "output", "cacheRead", "cacheWrite"] as const;
const record = (value: unknown): Record<string, any> | undefined =>
  value !== null && typeof value === "object"
    ? (value as Record<string, any>)
    : undefined;

export function normalizeTokenUsage(
  raw: unknown,
  model?: PriceModel,
): TokenUsage {
  const value = record(raw);
  if (!value) return unavailableUsage();
  const result = unavailableUsage();
  for (const field of fields)
    if (nonNegative(value[field])) result[field] = value[field];
  const complete = fields.every((field) => result[field] !== undefined);
  // Pi 0.85.1 SessionStats uses these four disjoint buckets, not reasoning subtypes.
  const sum = fields.reduce((total, field) => total + (result[field] ?? 0), 0);
  const total = complete
    ? sum
    : nonNegative(value.totalTokens)
      ? value.totalTokens
      : undefined;
  const cost = record(value.cost);
  const pricingKnown =
    model &&
    fields.every((field) => nonNegative(model.cost[field])) &&
    fields.some((field) => model.cost[field] > 0);
  if (cost && nonNegative(cost.total) && (pricingKnown || cost.total > 0)) {
    result.cost = {
      status: "complete",
      usd: cost.total,
      source: "pi-estimate",
    };
  }
  // Pi initializes missing provider usage to an all-zero object. That is not evidence
  // of a billed zero-token request. A session with no accounting entries is known zero.
  if (total === 0 || !nonNegative(total))
    return { ...unavailableUsage(), cost: result.cost };
  result.total = total;
  result.status = complete ? "complete" : "partial";
  if (
    nonNegative(value.reasoning) &&
    nonNegative(result.output) &&
    value.reasoning <= result.output
  )
    result.reasoning = value.reasoning;
  return result;
}

export function aggregateUsage(items: readonly TokenUsage[]): TokenUsage {
  if (!items.length)
    return {
      status: "complete",
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      cost: { status: "complete", usd: 0, source: "calculated" },
    };
  const known = items.filter((item) => nonNegative(item.total));
  const result = unavailableUsage();
  if (known.length) {
    result.status = items.every((item) => item.status === "complete")
      ? "complete"
      : "partial";
    const total = known.reduce((sum, item) => sum + item.total!, 0);
    if (!nonNegative(total)) return unavailableUsage();
    result.total = total;
    for (const field of [...fields, "reasoning"] as const) {
      const available = items.filter((item) => nonNegative(item[field]));
      if (available.length) {
        const sum = available.reduce((sum, item) => sum + item[field]!, 0);
        if (nonNegative(sum)) result[field] = sum;
      }
    }
  }
  const costs = items
    .map((item) => item.cost)
    .filter((cost) => nonNegative(cost.usd));
  if (costs.length) {
    const usd = costs.reduce((sum, cost) => sum + cost.usd!, 0);
    const sources = new Set(costs.map((cost) => cost.source));
    if (nonNegative(usd))
      result.cost = {
        status: items.every((item) => item.cost.status === "complete")
          ? "complete"
          : "partial",
        usd,
        source: sources.size === 1 ? costs[0].source : "mixed",
      };
  }
  return result;
}

/** Complete comparable snapshots may be subtracted. Incremental entries preserve
 * run coverage if either snapshot is partial, or old metadata becomes readable. */
export function subtractUsage(
  final: TokenUsage,
  baseline: TokenUsage,
  incremental?: TokenUsage,
): TokenUsage {
  if (incremental) return incremental;
  if (
    final.status !== "complete" ||
    baseline.status !== "complete" ||
    !nonNegative(final.total) ||
    !nonNegative(baseline.total) ||
    final.total < baseline.total
  )
    return unavailableUsage();
  const result: TokenUsage = {
    status: "complete",
    total: final.total - baseline.total,
    cost: { status: "unavailable", source: "unknown" },
  };
  for (const field of [...fields, "reasoning"] as const) {
    if (nonNegative(final[field]) && nonNegative(baseline[field])) {
      const delta = final[field]! - baseline[field]!;
      if (delta < 0) return unavailableUsage();
      result[field] = delta;
    }
  }
  if (
    final.cost.status === "complete" &&
    baseline.cost.status === "complete" &&
    nonNegative(final.cost.usd) &&
    nonNegative(baseline.cost.usd)
  ) {
    const usd = final.cost.usd - baseline.cost.usd;
    if (usd >= 0)
      result.cost = { status: "complete", usd, source: final.cost.source };
  }
  return result;
}

export function getConversationUsage(
  entries: readonly SessionEntry[],
  lookup?: ModelLookup,
): TokenUsage {
  const items: TokenUsage[] = [];
  for (const entry of entries) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      const message = entry.message;
      items.push(
        normalizeTokenUsage(
          message.usage,
          lookup?.(message.provider, message.model),
        ),
      );
    } else if (entry.type === "compaction" || entry.type === "branch_summary") {
      // A summary is an accounting-bearing request, even if an extension omitted usage.
      items.push(normalizeTokenUsage(entry.usage));
    } else if (
      entry.type === "message" &&
      entry.message.role === "toolResult" &&
      entry.message.usage
    ) {
      items.push(normalizeTokenUsage(entry.message.usage));
    }
    // custom worklens.run-end usage is a checkpoint, NEVER an extra contribution.
  }
  return aggregateUsage(items);
}

export function buildContextUsage(raw: unknown): ContextUsage {
  const value = record(raw);
  if (!value || !nonNegative(value.contextWindow) || value.contextWindow === 0)
    return { status: "unavailable" };
  if (!nonNegative(value.tokens) || !nonNegative(value.percent))
    return { status: "unavailable", contextWindow: value.contextWindow };
  return {
    status: "complete",
    tokens: value.tokens,
    contextWindow: value.contextWindow,
    percent: value.percent,
  };
}

export function readSelection(value: unknown): Selection | undefined {
  const data = record(value);
  if (
    !data ||
    typeof data.provider !== "string" ||
    typeof data.model !== "string" ||
    !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
      data.thinking,
    )
  )
    return undefined;
  return {
    provider: data.provider,
    model: data.model,
    thinking: data.thinking,
  };
}

export function getLatestRun(
  entries: readonly SessionEntry[],
  lookup?: ModelLookup,
  activeId?: string,
): RunUsage | undefined {
  const starts = entries.filter(
    (entry) =>
      entry.type === "custom" && entry.customType === "worklens.run-start",
  );
  const start = starts.at(-1);
  if (!start || start.type !== "custom") return undefined;
  const data = record(start.data);
  if (
    data?.version !== 1 ||
    typeof data.runId !== "string" ||
    typeof data.startedAt !== "string" ||
    !Number.isFinite(Date.parse(data.startedAt))
  )
    return undefined;
  const index = entries.indexOf(start);
  const end = entries
    .slice(index + 1)
    .find(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === "worklens.run-end" &&
        record(entry.data)?.runId === data.runId,
    );
  const endData = end?.type === "custom" ? record(end.data) : undefined;
  const terminal =
    endData?.version === 1 &&
    ["completed", "cancelled", "failed"].includes(endData.outcome) &&
    typeof endData.endedAt === "string" &&
    Date.parse(endData.endedAt) >= Date.parse(data.startedAt);
  const endIndex = end ? entries.indexOf(end) : entries.length;
  const consumption = getConversationUsage(
    entries.slice(index + 1, endIndex),
    lookup,
  );
  const state =
    activeId === data.runId
      ? "active"
      : terminal
        ? (endData!.outcome as "completed" | "cancelled" | "failed")
        : "incomplete";
  const endedAt = terminal ? (endData!.endedAt as string) : undefined;
  return {
    ...consumption,
    runId: data.runId,
    state,
    selection: readSelection(data),
    startedAt: data.startedAt,
    endedAt,
    elapsedMs: endedAt
      ? Date.parse(endedAt) - Date.parse(data.startedAt)
      : state === "active"
        ? Math.max(0, Date.now() - Date.parse(data.startedAt))
        : undefined,
  };
}

export class UsageService {
  private contributions = new Map<string, TokenUsage>();
  private revision = 0;
  private buildSequence = 0;
  private snapshot: GlobalUsage = {
    status: "complete",
    totalTokens: 0,
    scope: "retained-local-sessions",
    sessionCount: 0,
    readableSessionCount: 0,
    unavailableSessionCount: 0,
    revision: 0,
  };
  getGlobalUsage(): GlobalUsage {
    return { ...this.snapshot };
  }
  private commit() {
    const entries = [...this.contributions.values()];
    const usage = aggregateUsage(entries);
    const readableSessionCount = entries.filter((item) =>
      nonNegative(item.total),
    ).length;
    this.snapshot = {
      status: usage.status,
      totalTokens: usage.total,
      scope: "retained-local-sessions",
      sessionCount: entries.length,
      readableSessionCount,
      unavailableSessionCount: entries.length - readableSessionCount,
      revision: ++this.revision,
    };
  }
  update(id: string, usage: TokenUsage) {
    if (JSON.stringify(this.contributions.get(id)) === JSON.stringify(usage))
      return;
    this.contributions.set(id, usage);
    this.commit();
  }
  remove(id: string) {
    if (this.contributions.delete(id)) this.commit();
  }
  async rebuild(
    load: () => Promise<Map<string, TokenUsage>>,
  ): Promise<boolean> {
    const revision = this.revision;
    const build = ++this.buildSequence;
    const result = await load();
    // Do not stamp a stale asynchronous scan with a NEW revision. A concurrent
    // committed run/delete, or a newer rebuild, invalidates the entire old scan.
    if (revision !== this.revision || build !== this.buildSequence)
      return false;
    this.contributions = result;
    this.commit();
    return true;
  }
}

export function incompleteUsage(usage: TokenUsage): TokenUsage {
  return {
    ...usage,
    status: nonNegative(usage.total) ? "partial" : "unavailable",
    cost: {
      ...usage.cost,
      status: nonNegative(usage.cost.usd) ? "partial" : "unavailable",
    },
  };
}

export async function auditSessionFile(path: string): Promise<boolean> {
  const lines = (await readFile(path, "utf8"))
    .split("\n")
    .filter((line) => line.trim());
  let damaged = false;
  for (const line of lines) {
    try {
      JSON.parse(line);
    } catch {
      damaged = true;
    }
  }
  const header = JSON.parse(lines[0] ?? "null");
  if (header?.type !== "session" || typeof header.id !== "string")
    throw new Error("Invalid session header");
  return damaged;
}

export async function readRetainedUsage(
  paths: { sessions: string; runtime: string },
  lookup: ModelLookup,
  diagnostic: (message: string) => void,
): Promise<Map<string, TokenUsage>> {
  const result = new Map<string, TokenUsage>();
  const files = (await readdir(paths.sessions)).filter((file) =>
    file.endsWith(".jsonl"),
  );
  for (const file of files) {
    try {
      const path = join(paths.sessions, file);
      // Pi's tolerant reader skips malformed lines. Audit readability first so a
      // damaged accounting line cannot silently lower a supposedly complete total.
      const damaged = await auditSessionFile(path);
      if (damaged)
        diagnostic(
          "有一份本地会话用量无法完整读取，原文件已保留，统计可能不完整。",
        );
      const manager = SessionManager.open(path, paths.sessions, paths.runtime);
      const id = manager.getSessionId();
      if (result.has(id)) continue; // Session ID is the attribution identity, not the filename.
      const usage = getConversationUsage(manager.getEntries(), lookup);
      result.set(id, damaged ? incompleteUsage(usage) : usage);
    } catch {
      diagnostic("有一份本地会话用量无法读取，原文件已保留，统计可能不完整。");
      result.set(`unreadable:${file}`, unavailableUsage());
    }
  }
  return result;
}

/** Read-only equivalent of Pi 0.85.1 getContextUsage for a closed session.
 * Uses the same public helpers and active branch, without constructing an agent
 * or requiring credentials just to inspect historical usage. */
export function getHistoricalContext(
  manager: SessionManager,
  selection: Selection | undefined,
  lookup: ModelLookup,
): ContextUsage {
  const window =
    selection && lookup(selection.provider, selection.model)?.contextWindow;
  if (!nonNegative(window) || !window) return { status: "unavailable" };
  const branch = manager.getBranch();
  const compaction = branch.findLastIndex(
    (entry) => entry.type === "compaction",
  );
  if (compaction >= 0 && !getLastAssistantUsage(branch.slice(compaction + 1)))
    return { status: "unavailable", contextWindow: window };
  const messages = manager.buildSessionContext().messages;
  let tokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (
      message.role === "assistant" &&
      message.stopReason !== "error" &&
      message.stopReason !== "aborted" &&
      calculateContextTokens(message.usage) > 0
    ) {
      tokens += calculateContextTokens(message.usage);
      break;
    }
    tokens += estimateTokens(message);
  }
  return buildContextUsage({
    tokens,
    contextWindow: window,
    percent: (tokens / window) * 100,
  });
}

type ContextMessage = Parameters<typeof estimateTokens>[0];

/**
 * Identifies a message by its time and content, not its position, so a turn
 * kept by compaction keeps its segment (and animation) identity.
 */
function messageKey(message: ContextMessage, seen: Map<string, number>) {
  const stamp = (message as { timestamp?: unknown }).timestamp;
  const digest = createHash("sha1")
    .update(JSON.stringify(message))
    .digest("hex")
    .slice(0, 12);
  const key = `${typeof stamp === "number" ? stamp : "-"}:${digest}`;
  const count = (seen.get(key) ?? 0) + 1;
  seen.set(key, count);
  return count > 1 ? `${key}:${count}` : key;
}
const summaryRoles = new Set(["compactionSummary", "branchSummary"]);

/**
 * Splits the context into system prompt and tools, summaries, earlier turns and
 * the latest turn. Message sizes are estimates; when the provider reported the
 * context size, all segments are scaled to it. The system part is the session's
 * system messages plus the recorded tool schemas; with neither known, it is
 * inferred as the reported remainder.
 */
export function withContextSegments(
  context: ContextUsage,
  messages: readonly ContextMessage[],
  toolTokens: number | undefined,
  reserveTokens: number,
): ContextUsage {
  const window = context.contextWindow;
  const result: ContextUsage = { ...context };
  if (nonNegative(window) && window > reserveTokens)
    result.compactAt = window - reserveTokens;
  const parts: { id: string; kind: "summary" | "turn"; tokens: number }[] = [];
  let turn: (typeof parts)[number] | undefined;
  let systemMessages: number | undefined;
  const seen = new Map<string, number>();
  messages.forEach((message) => {
    if ((message.role as string) === "system") {
      // Pi keeps the full system prompt as a context message.
      systemMessages = (systemMessages ?? 0) + estimateTokens(message);
      return;
    }
    const tokens = estimateTokens(message);
    const key = messageKey(message, seen);
    if (summaryRoles.has(message.role)) {
      parts.push({ id: `summary:${key}`, kind: "summary", tokens });
      turn = undefined;
    } else if (message.role === "user" || !turn) {
      turn = { id: `turn:${key}`, kind: "turn", tokens };
      parts.push(turn);
    } else turn.tokens += tokens;
  });
  const messageTokens = parts.reduce((sum, part) => sum + part.tokens, 0);
  const known = nonNegative(context.tokens);
  const recorded =
    systemMessages !== undefined || nonNegative(toolTokens)
      ? (systemMessages ?? 0) + (toolTokens ?? 0)
      : undefined;
  const system = nonNegative(recorded)
    ? recorded
    : known
      ? Math.max(0, context.tokens! - messageTokens)
      : undefined;
  if (system === undefined || system + messageTokens <= 0) return result;
  const scale = known ? context.tokens! / (system + messageTokens) : 1;
  const lastTurn = parts.findLast((part) => part.kind === "turn");
  result.segments = [
    { id: "system", kind: "system" as const, tokens: system },
    ...parts.map((part) => ({
      id: part.id,
      kind:
        part.kind === "summary"
          ? ("summary" as const)
          : part === lastTurn
            ? ("turn" as const)
            : ("history" as const),
      tokens: part.tokens,
    })),
  ]
    .map((segment) => ({
      ...segment,
      tokens: Math.round(segment.tokens * scale),
    }))
    .filter((segment) => segment.tokens > 0);
  return result;
}

/** Estimated tokens of the tool schemas sent alongside the system prompt. */
export function estimateToolTokens(tools: readonly { exposure?: string }[]) {
  const sent = tools.filter(
    (tool) =>
      !tool.exposure || ["direct", "model-only"].includes(tool.exposure),
  );
  // Same character heuristic as Pi's estimateTokens.
  return sent.length ? Math.ceil(JSON.stringify(sent).length / 4) : 0;
}

/** Cache reads priced at the uncached input rate, minus what they cost. */
export function getCacheSavings(
  entries: readonly SessionEntry[],
  lookup: ModelLookup,
): number | undefined {
  let saved = 0;
  let priced = false;
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "assistant")
      continue;
    const read = entry.message.usage?.cacheRead;
    const model = lookup(entry.message.provider, entry.message.model);
    if (!nonNegative(read) || !read || !model) continue;
    const { input, cacheRead } = model.cost;
    if (!nonNegative(input) || !nonNegative(cacheRead) || input <= cacheRead)
      continue;
    saved += (read * (input - cacheRead)) / 1_000_000;
    priced = true;
  }
  return priced ? saved : undefined;
}

/** The tool schema size recorded by the latest run on this branch. */
export function readToolTokens(branch: readonly SessionEntry[]) {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry.type !== "custom" || entry.customType !== "worklens.run-start")
      continue;
    const value = record(entry.data)?.toolTokens;
    if (nonNegative(value)) return value;
  }
  return undefined;
}
