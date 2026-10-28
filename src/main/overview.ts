import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  SessionManager,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type {
  Overview,
  OverviewConversation,
  OverviewRequest,
  OverviewTopic,
  TokenUsage,
} from "../shared/contracts";
import {
  addDays,
  dayKey,
  daysBetween,
  granularityFor,
  parseDay,
  periodBuckets,
} from "../shared/date-range";
import { nonNegative } from "../shared/usage";
import {
  accountingItems,
  aggregateUsage,
  auditSessionFile,
  incompleteUsage,
  type ModelLookup,
} from "./usage";

type EntitySource = "jira" | "github" | "confluence";
type RunState = "completed" | "cancelled" | "failed" | "incomplete";
export interface SessionDigest {
  id: string;
  title?: string;
  /** The name and the start of the first prompt, for keyword topics. */
  text: string;
  createdAt: number;
  usage: { at: number; usage: TokenUsage; provider?: string; model?: string }[];
  runs: {
    id: string;
    at: number;
    state: RunState;
    provider?: string;
    model?: string;
  }[];
  /** The person's own messages, shortened; summaries read only these. */
  prompts: { at: number; text: string }[];
  /** Tool calls, including those Code Mode makes; not Code Mode itself. */
  tools: {
    at: number;
    name: string;
    entity?: { source: EntitySource; key: string };
  }[];
}

const record = (value: unknown): Record<string, any> | undefined =>
  value !== null && typeof value === "object"
    ? (value as Record<string, any>)
    : undefined;
const time = (entry: SessionEntry) => Date.parse(entry.timestamp);
const JIRA_ISSUE = /\b([A-Z][A-Z0-9_]{1,9})-\d+\b/;
const JIRA_PROJECT = /^[A-Z][A-Z0-9_]{1,9}$/;
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;
const SPACE = /^[\w~-]{1,64}$/;

/** The Jira project, repository or Confluence space a connector call targets. */
export function toolEntity(
  name: string,
  args: unknown,
): SessionDigest["tools"][number]["entity"] {
  const request = record(record(args)?.request);
  if (!request) return undefined;
  if (name.startsWith("jira_")) {
    const issue =
      typeof request.issue === "string"
        ? JIRA_ISSUE.exec(request.issue)?.[1]
        : undefined;
    const project =
      typeof request.project === "string" && JIRA_PROJECT.test(request.project)
        ? request.project
        : undefined;
    const key = issue ?? project;
    return key ? { source: "jira", key } : undefined;
  }
  if (name.startsWith("github_") && typeof request.repo === "string") {
    let repo = request.repo.trim().replace(/\.git$/, "");
    try {
      repo = new URL(repo).pathname
        .split("/")
        .filter(Boolean)
        .slice(0, 2)
        .join("/");
    } catch {
      // Already owner/repository.
    }
    return REPOSITORY.test(repo) ? { source: "github", key: repo } : undefined;
  }
  if (
    name.startsWith("confluence_") &&
    typeof request.space === "string" &&
    SPACE.test(request.space)
  )
    return { source: "confluence", key: request.space };
  return undefined;
}

/** Connector tools are counted per service; web tools as one group. */
export function toolGroup(name: string) {
  const prefix = name.split("_")[0];
  if (
    name.includes("_") &&
    ["jira", "github", "confluence", "jev"].includes(prefix)
  )
    return prefix;
  if (name.startsWith("web_")) return "web";
  return name;
}

const PROMPT_LIMIT = 400;
function userText(entry: SessionEntry) {
  if (entry.type !== "message" || entry.message.role !== "user")
    return undefined;
  const content = entry.message.content;
  return (
    typeof content === "string"
      ? content
      : content.map((part) => (part.type === "text" ? part.text : "")).join(" ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

export function digestSession(
  manager: SessionManager,
  lookup: ModelLookup,
  damaged = false,
): SessionDigest {
  const entries = manager.getEntries();
  const header = manager.getHeader();
  const usage = accountingItems(entries, lookup)
    .map((item) => ({
      at: time(item.entry),
      // A damaged file may be missing accounting lines.
      usage: damaged ? incompleteUsage(item.usage) : item.usage,
      provider: item.provider,
      model: item.model,
    }))
    .filter((item) => Number.isFinite(item.at));
  const ends = new Map<string, RunState>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== "worklens.run-end")
      continue;
    const data = record(entry.data);
    if (
      data?.version === 1 &&
      typeof data.runId === "string" &&
      ["completed", "cancelled", "failed"].includes(data.outcome)
    )
      ends.set(data.runId, data.outcome);
  }
  const runs: SessionDigest["runs"] = [];
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== "worklens.run-start")
      continue;
    const data = record(entry.data);
    const at = Date.parse(data?.startedAt);
    if (
      data?.version !== 1 ||
      typeof data.runId !== "string" ||
      !Number.isFinite(at)
    )
      continue;
    runs.push({
      id: data.runId,
      at,
      state: ends.get(data.runId) ?? "incomplete",
      provider: typeof data.provider === "string" ? data.provider : undefined,
      model: typeof data.model === "string" ? data.model : undefined,
    });
  }
  const tools: SessionDigest["tools"] = [];
  // Code Mode records each inner call when it starts and again when it ends.
  const nested = new Map<string, SessionDigest["tools"][number]>();
  for (const entry of entries) {
    const at = time(entry);
    if (!Number.isFinite(at)) continue;
    if (entry.type === "message" && entry.message.role === "assistant") {
      for (const part of entry.message.content)
        if (part.type === "toolCall" && part.name !== "codemode")
          tools.push({
            at,
            name: part.name,
            entity: toolEntity(part.name, part.arguments),
          });
    } else if (
      entry.type === "custom" &&
      entry.customType === "worklens.nested-tool"
    ) {
      const message = record(record(entry.data)?.message);
      if (
        typeof message?.toolId !== "string" ||
        typeof message.toolName !== "string" ||
        nested.has(message.toolId)
      )
        continue;
      let args: unknown;
      try {
        args = JSON.parse(message.args);
      } catch {
        args = undefined;
      }
      nested.set(message.toolId, {
        at,
        name: message.toolName,
        entity: toolEntity(message.toolName, args),
      });
    }
  }
  tools.push(...nested.values());
  tools.sort((x, y) => x.at - y.at);
  const prompts: SessionDigest["prompts"] = [];
  for (const entry of entries) {
    const text = userText(entry);
    const at = time(entry);
    if (text && Number.isFinite(at))
      prompts.push({ at, text: text.slice(0, PROMPT_LIMIT) });
  }
  const prompt = prompts[0]?.text ?? "";
  const name = manager.getSessionName();
  const createdAt = Date.parse(header?.timestamp ?? "");
  return {
    id: manager.getSessionId(),
    title: name || prompt.slice(0, 48) || undefined,
    text: [name, prompt.slice(0, 300)].filter(Boolean).join(" "),
    createdAt: Number.isFinite(createdAt) ? createdAt : (usage[0]?.at ?? 0),
    usage,
    runs,
    prompts,
    tools,
  };
}

/** Session digests, re-read only when a file's size or modification time changes. */
export class OverviewIndex {
  private files = new Map<
    string,
    { mtimeMs: number; size: number; digest?: SessionDigest }
  >();
  private tail: Promise<unknown> = Promise.resolve();

  read(paths: { sessions: string; runtime: string }, lookup: ModelLookup) {
    const result = this.tail.then(() => this.scan(paths, lookup));
    this.tail = result.catch(() => {});
    return result;
  }

  private async scan(
    paths: { sessions: string; runtime: string },
    lookup: ModelLookup,
  ) {
    const names = (await readdir(paths.sessions).catch(() => [])).filter(
      (name) => name.endsWith(".jsonl"),
    );
    const files = new Map<
      string,
      { mtimeMs: number; size: number; digest?: SessionDigest }
    >();
    const digests: SessionDigest[] = [];
    const seen = new Set<string>();
    let unreadable = 0;
    for (const name of names) {
      const path = join(paths.sessions, name);
      const info = await stat(path).catch(() => undefined);
      if (!info) continue;
      let file = this.files.get(path);
      if (file?.mtimeMs !== info.mtimeMs || file.size !== info.size) {
        let digest: SessionDigest | undefined;
        try {
          const damaged = await auditSessionFile(path);
          digest = digestSession(
            SessionManager.open(path, paths.sessions, paths.runtime),
            lookup,
            damaged,
          );
        } catch {
          digest = undefined;
        }
        file = { mtimeMs: info.mtimeMs, size: info.size, digest };
        // Parsing is synchronous; let pending IPC run between files.
        await new Promise((resolve) => setImmediate(resolve));
      }
      files.set(path, file);
      if (!file.digest) unreadable++;
      // Session ID is the attribution identity, not the filename.
      else if (!seen.has(file.digest.id)) {
        seen.add(file.digest.id);
        digests.push(file.digest);
      }
    }
    this.files = files;
    return { digests, unreadable };
  }
}

const STOP_WORDS = new Set([
  "帮我",
  "一下",
  "一个",
  "这个",
  "那个",
  "怎么",
  "如何",
  "什么",
  "可以",
  "我们",
  "你们",
  "他们",
  "进行",
  "以及",
  "然后",
  "需要",
  "现在",
  "还是",
  "没有",
  "就是",
  "已经",
  "因为",
  "所以",
  "但是",
  "如果",
  "这些",
  "那些",
  "这样",
  "问题",
  "看看",
  "请问",
  "一些",
  "关于",
  "使用",
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "from",
  "into",
  "please",
  "help",
  "what",
  "how",
  "why",
  "can",
  "you",
  "your",
  "are",
  "was",
  "will",
  "about",
  "have",
  "has",
  "make",
  "use",
  "using",
]);
const segmenter = new Intl.Segmenter("zh", { granularity: "word" });

export function keywords(text: string) {
  const words = new Set<string>();
  for (const { segment, isWordLike } of segmenter.segment(text)) {
    if (!isWordLike) continue;
    const word = segment.toLowerCase();
    if (/^\d+$/.test(word) || STOP_WORDS.has(word)) continue;
    if (/\p{Script=Han}/u.test(word) ? word.length < 2 : word.length < 3)
      continue;
    words.add(word);
  }
  return words;
}

const MAX_KEYWORD_TOPICS = 6;
/** Keywords shared by at least two conversations, most shared first. */
function keywordTopics(conversations: { id: string; text: string }[]) {
  const words = new Map(
    conversations.map((item) => [item.id, keywords(item.text)]),
  );
  const remaining = new Set(conversations.map((item) => item.id));
  const topics: { word: string; ids: string[] }[] = [];
  while (topics.length < MAX_KEYWORD_TOPICS) {
    const counts = new Map<string, number>();
    for (const id of remaining)
      for (const word of words.get(id)!)
        counts.set(word, (counts.get(word) ?? 0) + 1);
    const best = [...counts].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    )[0];
    if (!best || best[1] < 2) break;
    const ids = [...remaining].filter((id) => words.get(id)!.has(best[0]));
    ids.forEach((id) => remaining.delete(id));
    topics.push({ word: best[0], ids });
  }
  return topics;
}

const tokensOf = (usage: TokenUsage) =>
  nonNegative(usage.total) ? usage.total : 0;
const modelKey = (provider?: string, model?: string) =>
  provider && model ? `${provider}\u0000${model}` : "";

function slice(digest: SessionDigest, from: number, to: number) {
  const within = (item: { at: number }) => item.at >= from && item.at < to;
  return {
    digest,
    usage: digest.usage.filter(within),
    runs: digest.runs.filter(within),
    tools: digest.tools.filter(within),
  };
}
type Slice = ReturnType<typeof slice>;
const active = (item: Slice) => item.usage.length > 0 || item.runs.length > 0;
function usageBetween(source: Slice[], from: number, to: number) {
  return aggregateUsage(
    source.flatMap((item) =>
      item.usage.filter((u) => u.at >= from && u.at < to).map((u) => u.usage),
    ),
  );
}

export function buildOverview(
  digests: readonly SessionDigest[],
  request: OverviewRequest,
  options: { unreadable?: number } = {},
): Overview {
  const start = parseDay(request.start)!;
  const end = parseDay(request.end)!;
  const from = start.getTime();
  const to = addDays(end, 1).getTime();
  const slices = digests
    .map((digest) => slice(digest, from, to))
    .filter(active);
  const usage = usageBetween(slices, from, to);
  const runs = slices.flatMap((item) => item.runs);

  const firstActivity = digests
    .flatMap((digest) => [
      digest.createdAt,
      ...digest.usage.map((u) => u.at),
      ...digest.runs.map((r) => r.at),
    ])
    .filter((at) => at > 0);
  const earliest = firstActivity.length
    ? dayKey(new Date(Math.min(...firstActivity)))
    : undefined;

  let previous: Overview["previous"];
  let previousSlices: Slice[] = [];
  // Comparison buckets are the current ones moved back by this many days, so
  // they never depend on where calendar weeks fall in either period.
  let offset = 0;
  if (request.previous) {
    const previousStart = parseDay(request.previous.start)!;
    const previousTo = addDays(parseDay(request.previous.end)!, 1).getTime();
    offset = daysBetween(start, previousStart);
    previousSlices = digests
      .map((digest) => slice(digest, previousStart.getTime(), previousTo))
      .filter(active);
    previous = {
      ...request.previous,
      usage: usageBetween(previousSlices, previousStart.getTime(), previousTo),
      activeConversations: previousSlices.length,
      partial: !earliest || request.previous.start < earliest,
    };
  }

  const days = daysBetween(start, end) + 1;
  const granularity = granularityFor(days);
  const trend = periodBuckets(start, end, granularity, request.weekStart).map(
    (bucket) => {
      const a = bucket.start.getTime();
      const b = bucket.end.getTime();
      return {
        start: dayKey(bucket.start),
        end: dayKey(addDays(bucket.end, -1)),
        usage: usageBetween(slices, a, b),
        runs: runs.filter((run) => run.at >= a && run.at < b).length,
        previous: request.previous
          ? usageBetween(
              previousSlices,
              addDays(bucket.start, offset).getTime(),
              addDays(bucket.end, offset).getTime(),
            )
          : undefined,
      };
    },
  );

  const activity = Array.from({ length: 7 }, () =>
    Array.from(
      { length: 24 },
      (): { tokens: number; runs: number; partial?: boolean } => ({
        tokens: 0,
        runs: 0,
      }),
    ),
  );
  const cell = (at: number) => {
    const date = new Date(at);
    return activity[(date.getDay() - request.weekStart + 7) % 7][
      date.getHours()
    ];
  };
  const activeDays = new Set<string>();
  for (const item of slices) {
    for (const u of item.usage) {
      const target = cell(u.at);
      target.tokens += tokensOf(u.usage);
      if (u.usage.status !== "complete") target.partial = true;
      activeDays.add(dayKey(new Date(u.at)));
    }
    for (const run of item.runs) {
      cell(run.at).runs++;
      activeDays.add(dayKey(new Date(run.at)));
    }
  }

  const models = new Map<
    string,
    { provider?: string; model?: string; runs: number; items: TokenUsage[] }
  >();
  const modelEntry = (provider?: string, model?: string) => {
    const key = modelKey(provider, model);
    let entry = models.get(key);
    if (!entry)
      models.set(
        key,
        (entry = key
          ? { provider, model, runs: 0, items: [] }
          : { runs: 0, items: [] }),
      );
    return entry;
  };
  for (const item of slices) {
    for (const u of item.usage)
      modelEntry(u.provider, u.model).items.push(u.usage);
    for (const run of item.runs)
      if (run.provider && run.model) modelEntry(run.provider, run.model).runs++;
  }

  const tools = new Map<string, { name: string; calls: number }>();
  for (const item of slices)
    for (const tool of item.tools) {
      const name = toolGroup(tool.name);
      const entry = tools.get(name) ?? { name, calls: 0 };
      entry.calls++;
      tools.set(name, entry);
    }

  const conversations: OverviewConversation[] = slices.map((item) => {
    // Most recent first: runs and replies in time order, reversed.
    const used = [
      ...item.runs.map((run) => ({
        at: run.at,
        key: modelKey(run.provider, run.model),
      })),
      ...item.usage.map((u) => ({
        at: u.at,
        key: modelKey(u.provider, u.model),
      })),
    ]
      .filter((entry) => entry.key)
      .sort((a, b) => b.at - a.at);
    const keys = [...new Set(used.map((entry) => entry.key))];
    const last = Math.max(
      ...item.usage.map((u) => u.at),
      ...item.runs.map((r) => r.at),
    );
    return {
      id: item.digest.id,
      title: item.digest.title,
      topicId: "other",
      models: keys.map((key) => {
        const [provider, model] = key.split("\u0000");
        return { provider, model };
      }),
      runs: item.runs.length,
      usage: aggregateUsage(item.usage.map((u) => u.usage)),
      lastAt: new Date(last).toISOString(),
      days: [
        ...new Set(
          [...item.usage, ...item.runs].map((entry) =>
            dayKey(new Date(entry.at)),
          ),
        ),
      ].sort(),
    };
  });
  const byId = new Map(conversations.map((item) => [item.id, item]));

  // Connector targets in this period decide a topic first; keywords group the
  // rest. Targets from other periods never label this one.
  const topics = new Map<string, OverviewTopic>();
  const assign = (
    id: string,
    topic: Omit<OverviewTopic, "tokens" | "conversationIds">,
  ) => {
    const entry = topics.get(topic.id) ?? {
      ...topic,
      tokens: 0,
      conversationIds: [],
    };
    const conversation = byId.get(id)!;
    entry.tokens += tokensOf(conversation.usage);
    entry.conversationIds.push(id);
    conversation.topicId = topic.id;
    topics.set(topic.id, entry);
  };
  const unassigned: { id: string; text: string }[] = [];
  for (const item of slices) {
    const counts = new Map<
      string,
      { source: EntitySource; key: string; count: number }
    >();
    for (const tool of item.tools) {
      if (!tool.entity) continue;
      const id = `${tool.entity.source}:${tool.entity.key}`;
      const entry = counts.get(id) ?? { ...tool.entity, count: 0 };
      entry.count++;
      counts.set(id, entry);
    }
    const best = [...counts].sort((a, b) => b[1].count - a[1].count)[0];
    if (best)
      assign(item.digest.id, {
        id: best[0],
        label: best[1].key,
        source: best[1].source,
      });
    else unassigned.push({ id: item.digest.id, text: item.digest.text });
  }
  const grouped = new Set<string>();
  for (const topic of keywordTopics(unassigned))
    for (const id of topic.ids) {
      grouped.add(id);
      assign(id, {
        id: `keyword:${topic.word}`,
        label: topic.word,
        source: "keyword",
      });
    }
  for (const item of unassigned)
    if (!grouped.has(item.id))
      assign(item.id, { id: "other", source: "other" });
  const sortedTopics = [...topics.values()]
    .map((topic) => ({
      ...topic,
      conversationIds: topic.conversationIds.sort(
        (a, b) => tokensOf(byId.get(b)!.usage) - tokensOf(byId.get(a)!.usage),
      ),
    }))
    .sort(
      (a, b) =>
        Number(a.source === "other") - Number(b.source === "other") ||
        b.tokens - a.tokens ||
        b.conversationIds.length - a.conversationIds.length,
    );

  return {
    range: { start: request.start, end: request.end },
    previous,
    scope: "retained-local-sessions",
    retainedSessions: digests.length,
    unreadableSessions: options.unreadable ?? 0,
    usage,
    granularity,
    trend,
    activity,
    activeDays: [...activeDays].sort(),
    sessions: {
      created: digests.filter(
        (digest) => digest.createdAt >= from && digest.createdAt < to,
      ).length,
      active: slices.length,
      continued: slices.filter((item) => item.digest.createdAt < from).length,
      runs: runs.length,
      failedRuns: runs.filter((run) => run.state === "failed").length,
    },
    models: [...models.values()]
      .map(({ items, ...entry }) => ({
        ...entry,
        usage: aggregateUsage(items),
      }))
      // Usage without a model goes last.
      .sort(
        (a, b) =>
          Number(!a.model) - Number(!b.model) ||
          tokensOf(b.usage) - tokensOf(a.usage) ||
          b.runs - a.runs,
      ),
    tools: [...tools.values()].sort((a, b) => b.calls - a.calls),
    topics: sortedTopics,
    conversations: conversations.sort(
      (a, b) => tokensOf(b.usage) - tokensOf(a.usage),
    ),
  };
}
