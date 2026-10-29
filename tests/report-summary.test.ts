import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { SessionDigest } from "../src/main/overview";
import {
  parseSummaryReply,
  ReportSummaries,
  summaryInput,
} from "../src/main/report-summary";
import { schemas } from "../src/main/validation";
import { parseDay } from "../src/shared/date-range";
import type { ReportSummaryRequest } from "../src/shared/contracts";

const at = (day: string, hour = 10) => {
  const date = parseDay(day)!;
  date.setHours(hour);
  return date.getTime();
};
const digest = (
  id: string,
  prompts: string[],
  day = "2026-03-04",
  title = id,
): SessionDigest => ({
  id,
  title,
  text: title,
  createdAt: at(day),
  usage: [],
  runs: prompts.map((_, index) => ({
    id: `${id}-${index}`,
    at: at(day, 9 + index),
    state: "completed",
  })),
  prompts: prompts.map((text, index) => ({ at: at(day, 9 + index), text })),
  tools: [],
});
const request: ReportSummaryRequest = {
  start: "2026-03-02",
  end: "2026-03-08",
  language: "zh",
};
const identity = (text: string) => text;

describe("summary input", () => {
  test("sends only titles and this period's requests, redacted, under short references", () => {
    const input = summaryInput(
      [
        digest("a", ["first secret-token", "second"], "2026-03-04", "Plan"),
        digest("old", ["outside the range"], "2026-02-01"),
      ],
      request,
      (text) => text.replaceAll("secret-token", "[redacted]"),
    );
    expect(input.conversations).toBe(1);
    expect([...input.refs]).toEqual([["c1", "a"]]);
    expect(input.text).toContain('c1 | "Plan" | 2 runs');
    expect(input.text).toContain('"first [redacted]" / "second"');
    expect(input.text).not.toContain("secret-token");
    expect(input.text).not.toContain("outside the range");
  });

  test("long conversations keep their opening and latest requests", () => {
    const prompts = Array.from(
      { length: 10 },
      (_, index) => `request ${index}`,
    );
    const { text } = summaryInput([digest("a", prompts)], request, identity);
    for (const kept of [0, 1, 2, 7, 8, 9])
      expect(text).toContain(`"request ${kept}"`);
    for (const dropped of [3, 4, 5, 6])
      expect(text).not.toContain(`"request ${dropped}"`);
  });

  test("the fingerprint changes when the requests or the language change", () => {
    const base = summaryInput([digest("a", ["one"])], request, identity);
    expect(
      summaryInput([digest("a", ["one"])], request, identity).fingerprint,
    ).toBe(base.fingerprint);
    expect(
      summaryInput([digest("a", ["one", "two"])], request, identity)
        .fingerprint,
    ).not.toBe(base.fingerprint);
    expect(
      summaryInput(
        [digest("a", ["one"])],
        { ...request, language: "en" },
        identity,
      ).fingerprint,
    ).not.toBe(base.fingerprint);
  });

  test("the fingerprint ignores the dates while the covered conversations stay the same", () => {
    const base = summaryInput([digest("a", ["one"])], request, identity);
    const moved = summaryInput(
      [digest("a", ["one"])],
      { ...request, start: "2026-03-03", end: "2026-03-09" },
      identity,
    );
    expect(moved.text).toContain("Period: 2026-03-03 to 2026-03-09");
    expect(moved.fingerprint).toBe(base.fingerprint);
    // The same title and wording in another conversation is other work.
    const other = summaryInput(
      [digest("b", ["one"], "2026-03-04", "a")],
      request,
      identity,
    );
    expect(other.text).toBe(base.text);
    expect(other.fingerprint).not.toBe(base.fingerprint);
    // Moving past a day with work changes what the summary covers.
    expect(
      summaryInput(
        [digest("a", ["one"]), digest("b", ["two"], "2026-03-02")],
        { ...request, start: "2026-03-03", end: "2026-03-09" },
        identity,
      ).fingerprint,
    ).toBe(base.fingerprint);
    expect(
      summaryInput(
        [digest("a", ["one"]), digest("b", ["two"], "2026-03-02")],
        request,
        identity,
      ).fingerprint,
    ).not.toBe(base.fingerprint);
  });
});

describe("summary replies", () => {
  const refs = new Map([
    ["c1", "a"],
    ["c2", "b"],
  ]);
  test("reads fenced JSON and keeps only references that were sent", () => {
    const reply = parseSummaryReply(
      [
        "```json",
        JSON.stringify({
          summary: "Planned the release.",
          highlights: ["Release notes", "PR reviews"],
          themes: [
            {
              title: "Release",
              description: "Notes",
              conversations: ["c1", "c9"],
            },
            { title: "Again", description: "", conversations: ["c1"] },
            { title: "Review", description: "PRs", conversations: ["c2"] },
          ],
        }),
        "```",
      ].join("\n"),
      refs,
    );
    expect(reply).toEqual({
      summary: "Planned the release.",
      highlights: ["Release notes", "PR reviews"],
      themes: [
        { title: "Release", description: "Notes", conversationIds: ["a"] },
        { title: "Review", description: "PRs", conversationIds: ["b"] },
      ],
    });
  });

  test("keeps at most six highlights", () => {
    const reply = parseSummaryReply(
      JSON.stringify({
        summary: "Busy week.",
        highlights: ["1", "2", "3", "4", "5", "6", "7"],
      }),
      refs,
    );
    expect(reply.highlights).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(reply.themes).toEqual([]);
  });

  test.each(["not json", "{}", '{"summary": ""}', '{"summary": 3}'])(
    "%j is rejected instead of shown",
    (text) => {
      expect(() => parseSummaryReply(text, refs)).toThrow(
        "REPORT_SUMMARY_INVALID",
      );
    },
  );
});

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("report summaries", () => {
  async function setup(replies: (string | Error)[]) {
    const root = await mkdtemp(join(tmpdir(), "worklens-summary-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const calls: string[] = [];
    const runtime = {
      getModel: (provider: string, model: string) =>
        model === "missing"
          ? undefined
          : {
              id: model,
              provider,
              cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
            },
      completeSimple: async (model: { id: string }) => {
        calls.push(model.id);
        const next = replies.shift();
        if (next instanceof Error || next === undefined)
          throw next ?? new Error();
        return {
          role: "assistant",
          content: [{ type: "text", text: next }],
          stopReason: "stop",
          usage: {
            input: 100,
            output: 20,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 120,
            cost: { total: 0.01 },
          },
        };
      },
    } as unknown as ModelRuntime;
    return {
      root,
      calls,
      summaries: new ReportSummaries(runtime, root, identity),
    };
  }
  const reply = JSON.stringify({
    summary: "Worked on the plan.",
    highlights: ["Release plan"],
    themes: [{ title: "Plan", description: "", conversations: ["c1"] }],
  });

  test("tries models in order, skips unavailable ones, and saves the summary", async () => {
    const { root, calls, summaries } = await setup([new Error("busy"), reply]);
    const digests = [digest("a", ["one"])];
    const state = await summaries.generate(digests, request, [
      { provider: "p", model: "missing" },
      { provider: "p", model: "first" },
      { provider: "p", model: "second" },
    ]);
    expect(calls).toEqual(["first", "second"]);
    expect(state).toMatchObject({
      stale: false,
      conversations: 1,
      summary: {
        summary: "Worked on the plan.",
        model: { provider: "p", model: "second" },
        usage: { total: 120 },
        themes: [{ title: "Plan", conversationIds: ["a"] }],
      },
    });
    const saved = JSON.parse(
      await readFile(join(root, "report-summaries.json"), "utf8"),
    );
    expect(Object.keys(saved.entries)).toEqual(["2026-03-02|2026-03-08|zh"]);

    // A fresh instance reads the saved summary; new requests make it stale.
    const reopened = new ReportSummaries({} as ModelRuntime, root, identity);
    expect(await reopened.read(digests, request)).toMatchObject({
      stale: false,
      summary: { summary: "Worked on the plan." },
    });
    expect(
      await reopened.read([digest("a", ["one", "two"])], request),
    ).toMatchObject({ stale: true });
  });

  test("summaries saved by an earlier version still read; unreadable ones are dropped", async () => {
    const { root } = await setup([]);
    const old = {
      start: "2026-03-02",
      end: "2026-03-08",
      summary: "A long paragraph from before highlights existed.",
      themes: [{ title: "Plan", description: "", conversationIds: ["a"] }],
      next: [{ text: "Finish", conversationIds: ["a"] }],
      model: { provider: "p", model: "m" },
      usage: { status: "complete", total: 5, cost: { status: "unavailable" } },
      generatedAt: "2026-03-08T10:00:00.000Z",
      fingerprint: "old",
    };
    await writeFile(
      join(root, "report-summaries.json"),
      JSON.stringify({
        version: 1,
        entries: {
          "2026-03-02|2026-03-08|zh": old,
          "2026-03-02|2026-03-08|en": { summary: 3 },
        },
      }),
    );
    const summaries = new ReportSummaries({} as ModelRuntime, root, identity);
    const state = await summaries.read([digest("a", ["one"])], request);
    expect(state.summary).toMatchObject({
      summary: old.summary,
      highlights: [],
      themes: old.themes,
    });
    expect(state.summary).not.toHaveProperty("next");
    expect(
      (
        await summaries.read([digest("a", ["one"])], {
          ...request,
          language: "en",
        })
      ).summary,
    ).toBeUndefined();
  });

  test("a moved multi-day range shows its latest earlier summary; a day range does not", async () => {
    const { root } = await setup([]);
    const digests = [digest("a", ["one"])];
    const saved = (
      range: ReportSummaryRequest,
      summary: string,
      generatedAt = `${range.end}T10:00:00.000Z`,
    ) => ({
      start: range.start,
      end: range.end,
      summary,
      highlights: [],
      themes: [],
      model: { provider: "p", model: "m" },
      usage: { status: "complete", total: 5, cost: { status: "unavailable" } },
      generatedAt,
      fingerprint: summaryInput(digests, range, identity).fingerprint,
    });
    const ranges = {
      week: { start: "2026-03-01", end: "2026-03-07", language: "zh" },
      olderWeek: { start: "2026-02-28", end: "2026-03-06", language: "zh" },
      laterWeek: { start: "2026-03-03", end: "2026-03-09", language: "zh" },
      englishWeek: { start: "2026-03-01", end: "2026-03-07", language: "en" },
      month: { start: "2026-02-06", end: "2026-03-07", language: "zh" },
      day: { start: "2026-03-07", end: "2026-03-07", language: "zh" },
    } satisfies Record<string, ReportSummaryRequest>;
    await writeFile(
      join(root, "report-summaries.json"),
      JSON.stringify({
        version: 1,
        entries: Object.fromEntries(
          Object.entries(ranges).map(([name, range]) => [
            `${range.start}|${range.end}|${range.language}`,
            // The older week was regenerated later; the range still decides.
            saved(
              range,
              name,
              name === "olderWeek" ? "2026-03-08T10:00:00.000Z" : undefined,
            ),
          ]),
        ),
      }),
    );
    const summaries = new ReportSummaries({} as ModelRuntime, root, identity);

    expect(await summaries.read(digests, request)).toMatchObject({
      summary: { summary: "week", start: "2026-03-01" },
      stale: false,
    });
    expect(
      await summaries.read(
        [...digests, digest("b", ["two"], "2026-03-08")],
        request,
      ),
    ).toMatchObject({ summary: { summary: "week" }, stale: true });
    expect(
      (await summaries.read(digests, { ...request, language: "en" })).summary,
    ).toMatchObject({ summary: "englishWeek" });
    expect(
      (
        await summaries.read(digests, {
          start: "2026-02-07",
          end: "2026-03-08",
          language: "zh",
        })
      ).summary,
    ).toMatchObject({ summary: "month" });
    // Nothing in the range, or a single day: no earlier summary stands in.
    expect(
      (await summaries.read([digest("old", ["x"], "2026-01-01")], request))
        .summary,
    ).toBeUndefined();
    expect(
      (
        await summaries.read([digest("a", ["one"], "2026-03-08")], {
          start: "2026-03-08",
          end: "2026-03-08",
          language: "zh",
        })
      ).summary,
    ).toBeUndefined();
  });

  test("reports a reason when no model can produce a summary", async () => {
    const { summaries } = await setup(["no json here"]);
    const digests = [digest("a", ["one"])];
    await expect(summaries.generate(digests, request, [])).rejects.toThrow(
      "REPORT_SUMMARY_NO_MODELS",
    );
    await expect(
      summaries.generate(digests, request, [{ provider: "p", model: "only" }]),
    ).rejects.toThrow("REPORT_SUMMARY_INVALID");
    await expect(
      summaries.generate([], request, [{ provider: "p", model: "only" }]),
    ).rejects.toThrow("REPORT_SUMMARY_EMPTY");
    expect(await summaries.read(digests, request)).toMatchObject({
      summary: undefined,
      stale: false,
    });
  });
});

test("report settings accept up to five summary models", () => {
  const model = { provider: "p", model: "m" };
  expect(
    schemas.settings.safeParse({
      reportSummary: { enabled: true, models: [model] },
    }).success,
  ).toBe(true);
  expect(
    schemas.settings.safeParse({
      reportSummary: { enabled: true, models: Array(6).fill(model) },
    }).success,
  ).toBe(false);
});
