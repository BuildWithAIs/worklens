import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
  ReportSummary,
  ReportSummaryModel,
  ReportSummaryRequest,
  ReportSummaryState,
} from "../shared/contracts";
import { addDays, parseDay } from "../shared/date-range";
import { nonNegative } from "../shared/usage";
import type { SessionDigest } from "./overview";
import { atomicJson } from "./storage";
import { normalizeTokenUsage } from "./usage";

// Only titles and the person's own requests are sent, shortened and redacted.
const MAX_CONVERSATIONS = 40;
const REQUESTS_PER_CONVERSATION = 6;
const REQUEST_LIMIT = 280;
const INPUT_LIMIT = 24_000;
const MAX_CACHED = 30;

export interface SummaryInput {
  /** Short references sent to the model, mapped back to conversation IDs. */
  refs: Map<string, string>;
  text: string;
  fingerprint: string;
  conversations: number;
}

export function summaryInput(
  digests: readonly SessionDigest[],
  request: ReportSummaryRequest,
  redact: (text: string) => string,
): SummaryInput {
  const from = parseDay(request.start)!.getTime();
  const to = addDays(parseDay(request.end)!, 1).getTime();
  const within = (item: { at: number }) => item.at >= from && item.at < to;
  const active = digests
    .map((digest) => {
      const tokens = digest.usage
        .filter(within)
        .reduce(
          (sum, item) =>
            sum + (nonNegative(item.usage.total) ? item.usage.total : 0),
          0,
        );
      const runs = digest.runs.filter(within).length;
      const prompts = digest.prompts.filter(within).map((item) => item.text);
      return { digest, tokens, runs, prompts };
    })
    .filter((item) => item.runs > 0 || item.prompts.length > 0)
    .sort((a, b) => b.tokens - a.tokens || b.runs - a.runs)
    .slice(0, MAX_CONVERSATIONS);
  const refs = new Map<string, string>();
  const lines: string[] = [];
  let length = 0;
  for (const [index, item] of active.entries()) {
    const ref = `c${index + 1}`;
    // The opening requests say what it was about; the latest say where it went.
    const half = REQUESTS_PER_CONVERSATION / 2;
    const picked =
      item.prompts.length > REQUESTS_PER_CONVERSATION
        ? [...item.prompts.slice(0, half), ...item.prompts.slice(-half)]
        : item.prompts;
    const requests = picked
      .map((text) => JSON.stringify(redact(text).slice(0, REQUEST_LIMIT)))
      .join(" / ");
    const title = redact(item.digest.title ?? "").slice(0, 120);
    const line = `${ref} | ${JSON.stringify(title)} | ${item.runs} runs | requests: ${requests || "none"}`;
    if (length + line.length > INPUT_LIMIT) break;
    refs.set(ref, item.digest.id);
    lines.push(line);
    length += line.length;
  }
  const text = [
    `Period: ${request.start} to ${request.end} (local dates).`,
    `Conversations (${lines.length}):`,
    ...lines,
  ].join("\n");
  return {
    refs,
    text,
    fingerprint: createHash("sha256")
      .update(`${request.language}\n${text}`)
      .digest("hex"),
    conversations: refs.size,
  };
}

export function summaryPrompt(language: ReportSummaryRequest["language"]) {
  return [
    "You summarize a person's recent work in WorkLens, a desktop AI assistant, using only the conversation titles and the requests they sent.",
    "Describe what they worked on. Do not guess results, causes, quality or effort, and do not give advice.",
    `Write in ${language === "zh" ? "Simplified Chinese" : "English"}. Keep every text short.`,
    "Reply with one JSON object and nothing else:",
    '{"summary": "one sentence, at most 25 words", "highlights": ["a short phrase about one piece of work"], "themes": [{"title": "2 to 6 words", "description": "one short sentence", "conversations": ["c1"]}]}',
    `Give 3 to 6 highlights, each at most ${language === "zh" ? "20 characters" : "8 words"}, naming concrete work rather than repeating the summary.`,
    "Give 1 to 6 themes; put each conversation in at most one theme and use only the given references.",
  ].join("\n");
}

const replySchema = z.object({
  summary: z.string().trim().min(1).max(400),
  highlights: z.array(z.string().trim().min(1).max(80)).max(8).default([]),
  themes: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(80),
        description: z.string().trim().max(300).default(""),
        conversations: z.array(z.string()).max(60).default([]),
      }),
    )
    .max(8)
    .default([]),
});

/** Reads the model's JSON, keeping only references that were sent. */
export function parseSummaryReply(text: string, refs: Map<string, string>) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("REPORT_SUMMARY_INVALID");
  let value: unknown;
  try {
    value = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error("REPORT_SUMMARY_INVALID");
  }
  const parsed = replySchema.safeParse(value);
  if (!parsed.success) throw new Error("REPORT_SUMMARY_INVALID");
  const used = new Set<string>();
  const ids = (list: string[], exclusive: boolean) =>
    [...new Set(list)]
      .filter((ref) => refs.has(ref) && !(exclusive && used.has(ref)))
      .map((ref) => {
        if (exclusive) used.add(ref);
        return refs.get(ref)!;
      });
  return {
    summary: parsed.data.summary,
    highlights: parsed.data.highlights.slice(0, 6),
    themes: parsed.data.themes
      .map((theme) => ({
        title: theme.title,
        description: theme.description,
        conversationIds: ids(theme.conversations, true),
      }))
      .filter((theme) => theme.conversationIds.length > 0),
  };
}

type Cache = { version: 1; entries: Record<string, ReportSummary> };
// Saved summaries may come from an earlier version of this format: missing
// optional parts get defaults, and an entry that cannot be read is dropped.
const savedSchema = z.object({
  start: z.string(),
  end: z.string(),
  summary: z.string(),
  highlights: z.array(z.string()).default([]),
  themes: z
    .array(
      z.object({
        title: z.string(),
        description: z.string().default(""),
        conversationIds: z.array(z.string()),
      }),
    )
    .default([]),
  model: z.object({
    provider: z.string(),
    model: z.string(),
    thinking: z
      .enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
      .optional(),
  }),
  usage: z.custom<ReportSummary["usage"]>(
    (value) =>
      !!value &&
      typeof value === "object" &&
      typeof (value as { status?: unknown }).status === "string" &&
      !!(value as { cost?: unknown }).cost,
  ),
  generatedAt: z.string(),
  fingerprint: z.string(),
});
const cacheKey = (request: ReportSummaryRequest) =>
  `${request.start}|${request.end}|${request.language}`;

/** Summaries for the usage report, saved per range and language. */
export class ReportSummaries {
  private cache?: Cache;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private runtime: ModelRuntime,
    private userData: string,
    private redact: (text: string) => string,
  ) {}

  private get file() {
    return join(this.userData, "report-summaries.json");
  }

  private async load(): Promise<Cache> {
    if (this.cache) return this.cache;
    try {
      const value = JSON.parse(await readFile(this.file, "utf8"));
      const entries: Record<string, ReportSummary> = {};
      if (
        value?.version === 1 &&
        value.entries &&
        typeof value.entries === "object"
      )
        for (const [key, entry] of Object.entries(value.entries)) {
          const parsed = savedSchema.safeParse(entry);
          if (parsed.success) entries[key] = parsed.data;
        }
      this.cache = { version: 1, entries };
    } catch {
      this.cache = { version: 1, entries: {} };
    }
    return this.cache!;
  }

  async read(
    digests: readonly SessionDigest[],
    request: ReportSummaryRequest,
  ): Promise<ReportSummaryState> {
    const input = summaryInput(digests, request, this.redact);
    const summary = (await this.load()).entries[cacheKey(request)];
    return {
      summary,
      stale: !!summary && summary.fingerprint !== input.fingerprint,
      conversations: input.conversations,
    };
  }

  generate(
    digests: readonly SessionDigest[],
    request: ReportSummaryRequest,
    models: readonly ReportSummaryModel[],
  ): Promise<ReportSummaryState> {
    // One request at a time, so two clicks never pay for two summaries.
    const result = this.tail.then(async () => {
      if (!models.length) throw new Error("REPORT_SUMMARY_NO_MODELS");
      const input = summaryInput(digests, request, this.redact);
      if (!input.conversations) throw new Error("REPORT_SUMMARY_EMPTY");
      let failure = "REPORT_SUMMARY_FAILED";
      for (const choice of models) {
        const model = this.runtime.getModel(choice.provider, choice.model);
        if (!model) continue;
        const thinking =
          choice.thinking && choice.thinking !== "off"
            ? choice.thinking
            : undefined;
        try {
          const reply = await this.runtime.completeSimple(
            model,
            {
              systemPrompt: summaryPrompt(request.language),
              messages: [
                { role: "user", content: input.text, timestamp: Date.now() },
              ],
            },
            {
              // Thinking needs room before the JSON reply.
              maxTokens: thinking ? 8000 : 1600,
              signal: AbortSignal.timeout(thinking ? 180_000 : 90_000),
              ...(thinking ? { reasoning: thinking } : {}),
            },
          );
          if (reply.stopReason === "error" || reply.stopReason === "aborted")
            throw new Error("REPORT_SUMMARY_FAILED");
          const text = reply.content
            .map((part) => (part.type === "text" ? part.text : ""))
            .join("");
          const summary: ReportSummary = {
            start: request.start,
            end: request.end,
            ...parseSummaryReply(text, input.refs),
            model: choice,
            usage: normalizeTokenUsage(reply.usage, model),
            generatedAt: new Date().toISOString(),
            fingerprint: input.fingerprint,
          };
          await this.save(request, summary);
          return {
            summary,
            stale: false,
            conversations: input.conversations,
          };
        } catch (error) {
          // The next model may still answer; keep only a known reason.
          failure =
            error instanceof Error && error.message === "REPORT_SUMMARY_INVALID"
              ? "REPORT_SUMMARY_INVALID"
              : "REPORT_SUMMARY_FAILED";
        }
      }
      throw new Error(failure);
    });
    this.tail = result.catch(() => {});
    return result;
  }

  private async save(request: ReportSummaryRequest, summary: ReportSummary) {
    const cache = await this.load();
    const entries = { ...cache.entries, [cacheKey(request)]: summary };
    const kept = Object.entries(entries)
      .sort((a, b) => b[1].generatedAt.localeCompare(a[1].generatedAt))
      .slice(0, MAX_CACHED);
    this.cache = { version: 1, entries: Object.fromEntries(kept) };
    await atomicJson(this.file, this.cache);
  }
}
