import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  buildOverview,
  digestSession,
  keywords,
  toolEntity,
  toolGroup,
  type SessionDigest,
} from "../src/main/overview";
import { AgentService } from "../src/main/agent-service";
import { schemas } from "../src/main/validation";
import { dayKey, parseDay } from "../src/shared/date-range";
import { unavailableUsage } from "../src/shared/usage";
import type {
  ChatEvent,
  OverviewRequest,
  TokenUsage,
} from "../src/shared/contracts";
import { fixtureModel, mockServer } from "./mock-server";

const at = (day: string, hour = 10) => {
  const date = parseDay(day)!;
  date.setHours(hour);
  return date.getTime();
};
const usage = (
  total: number,
  status: TokenUsage["status"] = "complete",
): TokenUsage => ({
  status,
  input: total * 0.4,
  output: total * 0.1,
  cacheRead: total * 0.5,
  cacheWrite: 0,
  total,
  cost: { status: "complete", usd: total / 1000, source: "pi-estimate" },
});
const digest = (
  id: string,
  value: Partial<SessionDigest> = {},
): SessionDigest => ({
  id,
  title: id,
  text: id,
  createdAt: value.usage?.[0]?.at ?? value.runs?.[0]?.at ?? 0,
  usage: [],
  runs: [],
  prompts: [],
  tools: [],
  ...value,
});
const week: OverviewRequest = {
  start: "2026-03-02",
  end: "2026-03-08",
  previous: { start: "2026-02-23", end: "2026-03-01" },
  weekStart: 1,
};
const totals = (items: { total?: number }[]) =>
  items.reduce((sum, item) => sum + (item.total ?? 0), 0);

describe("overview aggregation", () => {
  test("attributes usage by time, splitting a conversation across the range boundary", () => {
    const overview = buildOverview(
      [
        digest("a", {
          createdAt: at("2026-02-01"),
          usage: [
            { at: at("2026-03-01"), usage: usage(100) },
            { at: at("2026-03-03", 15), usage: usage(200) },
          ],
          runs: [
            { id: "r1", at: at("2026-03-01"), state: "completed" },
            { id: "r2", at: at("2026-03-03", 15), state: "completed" },
          ],
        }),
      ],
      week,
    );
    expect(overview.usage.total).toBe(200);
    expect(overview.previous).toMatchObject({
      usage: { total: 100 },
      activeConversations: 1,
      partial: false,
    });
    expect(overview.conversations).toEqual([
      expect.objectContaining({ id: "a", runs: 1, days: ["2026-03-03"] }),
    ]);
    expect(overview.conversations[0].usage.total).toBe(200);
    expect(overview.granularity).toBe("day");
    expect(overview.trend).toHaveLength(7);
    expect(overview.trend[1]).toMatchObject({
      start: "2026-03-03",
      usage: { total: 200 },
      runs: 1,
    });
    // The comparison day is the same offset back: 1 March for 8 March.
    expect(overview.trend[6].previous?.total).toBe(100);
    // Tuesday is the second row when weeks start on Monday.
    expect(overview.activity[1][15]).toEqual({ tokens: 200, runs: 1 });
    expect(overview.activeDays).toEqual(["2026-03-03"]);
    expect(overview.sessions).toMatchObject({
      active: 1,
      created: 0,
      continued: 1,
      runs: 1,
    });
    expect(overview.retainedSessions).toBe(1);
  });

  test("keeps partial usage partial and reports a comparison before retained history", () => {
    const overview = buildOverview(
      [
        digest("a", {
          usage: [
            { at: at("2026-03-02"), usage: usage(10) },
            { at: at("2026-03-03"), usage: usage(10, "partial") },
          ],
        }),
      ],
      week,
    );
    expect(overview.usage).toMatchObject({ status: "partial", total: 20 });
    expect(overview.trend[1].usage.status).toBe("partial");
    expect(overview.previous?.partial).toBe(true);
  });

  test("runs without reported usage stay unknown instead of becoming zero", () => {
    const overview = buildOverview(
      [
        digest("a", {
          usage: [{ at: at("2026-03-04", 9), usage: unavailableUsage() }],
          runs: [{ id: "r", at: at("2026-03-04", 9), state: "completed" }],
        }),
      ],
      week,
    );
    expect(overview.usage.status).toBe("unavailable");
    expect(overview.usage.total).toBeUndefined();
    expect(overview.trend[2]).toMatchObject({ runs: 1 });
    expect(overview.trend[2].usage.total).toBeUndefined();
    expect(overview.activity[2][9]).toEqual({
      tokens: 0,
      runs: 1,
      partial: true,
    });
    expect(overview.conversations[0].usage.status).toBe("unavailable");
  });

  test("an empty range is a known zero with no conversations", () => {
    const overview = buildOverview(
      [digest("a", { usage: [{ at: at("2026-01-01"), usage: usage(5) }] })],
      week,
    );
    expect(overview.usage).toMatchObject({ status: "complete", total: 0 });
    expect(overview.conversations).toEqual([]);
    expect(overview.topics).toEqual([]);
    expect(overview.retainedSessions).toBe(1);
  });

  test("trend buckets follow the range length and the week start", () => {
    const build = (start: string, end: string, weekStart = 1) =>
      buildOverview([], { start, end, weekStart });
    expect(build("2026-03-01", "2026-03-31").granularity).toBe("day");
    const weekly = build("2026-03-01", "2026-04-01");
    expect(weekly.granularity).toBe("week");
    // Sunday 1 March is its own partial week; the next bucket starts Monday.
    expect(
      weekly.trend.slice(0, 2).map((item) => [item.start, item.end]),
    ).toEqual([
      ["2026-03-01", "2026-03-01"],
      ["2026-03-02", "2026-03-08"],
    ]);
    expect(build("2026-03-01", "2026-04-01", 0).trend[0]).toMatchObject({
      start: "2026-03-01",
      end: "2026-03-07",
    });
    expect(build("2026-01-15", "2026-08-01").granularity).toBe("month");
  });

  test("comparison buckets add up to the comparison total when calendar weeks fall differently", () => {
    const overview = buildOverview(
      [
        digest("a", {
          usage: [
            { at: at("2026-04-29"), usage: usage(10) },
            { at: at("2026-07-27"), usage: usage(100) },
          ],
        }),
      ],
      {
        start: "2026-07-28",
        end: "2026-10-25",
        previous: { start: "2026-04-29", end: "2026-07-27" },
        weekStart: 1,
      },
    );
    expect(overview.granularity).toBe("week");
    expect(overview.previous?.usage.total).toBe(110);
    expect(totals(overview.trend.map((item) => item.previous ?? {}))).toBe(110);
  });

  test("connector targets in the period decide topics first, then shared keywords, then other", () => {
    const day = at("2026-03-04");
    const overview = buildOverview(
      [
        digest("jira", {
          usage: [{ at: day, usage: usage(500) }],
          tools: [
            {
              at: day,
              name: "jira_read",
              entity: { source: "jira", key: "WL" },
            },
            {
              at: day,
              name: "jira_read",
              entity: { source: "jira", key: "WL" },
            },
            {
              at: day,
              name: "github_read",
              entity: { source: "github", key: "a/b" },
            },
          ],
        }),
        digest("report-1", {
          text: "周报 草稿",
          usage: [{ at: day, usage: usage(40) }],
        }),
        digest("report-2", {
          text: "整理 周报",
          usage: [{ at: day, usage: usage(60) }],
        }),
        digest("misc", {
          text: "翻译 邮件",
          usage: [{ at: day, usage: usage(900) }],
        }),
      ],
      week,
    );
    expect(
      overview.topics.map((topic) => [topic.id, topic.conversationIds]),
    ).toEqual([
      ["jira:WL", ["jira"]],
      ["keyword:周报", ["report-2", "report-1"]],
      ["other", ["misc"]],
    ]);
    expect(overview.topics[1]).toMatchObject({
      label: "周报",
      source: "keyword",
      tokens: 100,
    });
  });

  test("a repository read in an earlier period does not label this one", () => {
    const overview = buildOverview(
      [
        digest("old", {
          text: "邀请 文案",
          usage: [{ at: at("2026-03-05"), usage: usage(500) }],
          tools: [
            {
              at: at("2026-02-02"),
              name: "github_read",
              entity: { source: "github", key: "demo/old-notes" },
            },
          ],
        }),
      ],
      week,
    );
    expect(overview.topics.map((topic) => topic.id)).toEqual(["other"]);
  });

  test("lists every model a conversation used, most recent first, and keeps unattributed usage", () => {
    const day = at("2026-03-04");
    const overview = buildOverview(
      [
        digest("mixed", {
          usage: [
            { at: day, usage: usage(1000), provider: "p", model: "small" },
            { at: day + 60_000, usage: usage(10), provider: "p", model: "big" },
            { at: day + 120_000, usage: usage(5) },
          ],
          runs: [
            {
              id: "1",
              at: day,
              state: "completed",
              provider: "p",
              model: "small",
            },
            {
              id: "2",
              at: day + 60_000,
              state: "failed",
              provider: "p",
              model: "big",
            },
          ],
        }),
      ],
      week,
    );
    expect(overview.conversations[0].models).toEqual([
      { provider: "p", model: "big" },
      { provider: "p", model: "small" },
    ]);
    expect(
      overview.models.map((item) => [item.model, item.runs, item.usage.total]),
    ).toEqual([
      ["small", 1, 1000],
      ["big", 1, 10],
      [undefined, 0, 5],
    ]);
    expect(overview.sessions.failedRuns).toBe(1);
  });
});

describe("session digests", () => {
  test("count tools Code Mode calls once each, not Code Mode itself", () => {
    const root = tmpdir();
    const manager = SessionManager.inMemory(root);
    manager.appendMessage({
      role: "user",
      content: "Check WL tickets",
      timestamp: Date.now(),
    });
    manager.appendMessage({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "outer",
          name: "codemode",
          arguments: { code: "…" },
        },
      ],
      api: "openai-completions",
      provider: "p",
      model: "m",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: Date.now(),
    });
    const inner = {
      id: "inner",
      role: "tool",
      toolId: "inner",
      toolName: "jira_read",
      parentToolCallId: "outer",
      args: JSON.stringify({ request: { issue: "WL-7" } }, null, 2),
    };
    manager.appendCustomEntry("worklens.nested-tool", {
      message: { ...inner, status: "running" },
    });
    manager.appendCustomEntry("worklens.nested-tool", {
      message: { ...inner, status: "error" },
    });
    const digested = digestSession(manager, () => undefined);
    expect(digested.tools).toEqual([
      expect.objectContaining({
        name: "jira_read",
        entity: { source: "jira", key: "WL" },
      }),
    ]);
    expect(digested.title).toBe("Check WL tickets");
  });
});

describe("connector targets and keywords", () => {
  test("reads Jira projects, GitHub repositories and Confluence spaces from tool requests", () => {
    expect(
      toolEntity("jira_read", {
        request: { issue: "https://x.atlassian.net/browse/WL-12" },
      }),
    ).toEqual({ source: "jira", key: "WL" });
    expect(toolEntity("jira_write", { request: { project: "OPS" } })).toEqual({
      source: "jira",
      key: "OPS",
    });
    expect(
      toolEntity("jira_read", { request: { project: "10023" } }),
    ).toBeUndefined();
    expect(
      toolEntity("github_read", {
        request: { repo: "https://github.com/BuildWithAIs/worklens/pull/3" },
      }),
    ).toEqual({ source: "github", key: "BuildWithAIs/worklens" });
    expect(
      toolEntity("github_read", { request: { repo: "owner/repo.git" } }),
    ).toEqual({ source: "github", key: "owner/repo" });
    expect(
      toolEntity("confluence_read", { request: { space: "ENG" } }),
    ).toEqual({ source: "confluence", key: "ENG" });
    expect(toolEntity("read", { path: "WL-1.md" })).toBeUndefined();
  });

  test("groups connector tools per service and keeps other tool names", () => {
    expect(
      [
        "jira_read",
        "jira_write",
        "github_read",
        "web_search",
        "web_fetch",
        "bash",
      ].map(toolGroup),
    ).toEqual(["jira", "jira", "github", "web", "web", "bash"]);
  });

  test("keywords skip stop words, numbers and single characters", () => {
    expect([...keywords("帮我 写 周报 for Release notes 2026")]).toEqual([
      "周报",
      "release",
      "notes",
    ]);
  });
});

describe("overview request validation", () => {
  const valid = { start: "2026-03-02", end: "2026-03-08", weekStart: 1 };
  test.each([
    [valid, true],
    [{ ...valid, previous: { start: "2026-02-23", end: "2026-03-01" } }, true],
    [{ ...valid, start: "2026-03-09" }, false],
    [{ ...valid, end: "2026-02-30" }, false],
    [{ ...valid, start: "2/3/2026" }, false],
    [{ ...valid, weekStart: 7 }, false],
    [{ ...valid, previous: { start: "2026-03-01", end: "2026-02-01" } }, false],
    [{ ...valid, start: "2000-01-01" }, false],
  ])("%j is valid: %s", (input, expected) => {
    expect(schemas.overview.safeParse(input).success).toBe(expected);
  });
});

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("the service reads retained sessions and picks up new runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "worklens-overview-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const paths = {
    runtime: join(root, "runtime"),
    sessions: join(root, "sessions"),
    userData: join(root, "app"),
  };
  const server = await mockServer();
  cleanups.push(server.close);
  const runtime = await ModelRuntime.create({ modelsPath: null });
  runtime.registerProvider("worklens-test", {
    api: "openai-completions",
    baseUrl: server.url,
    apiKey: "fixture",
    models: [fixtureModel],
  });
  await runtime.refresh({ allowNetwork: false });
  const events: ChatEvent[] = [];
  const service = new AgentService(
    runtime,
    paths,
    (event) => events.push(event),
    (text) => text.replaceAll("secret-title", "[redacted]"),
  );
  await service.initialize();
  cleanups.push(() => service.shutdown());
  const selection = {
    provider: "worklens-test",
    model: fixtureModel.id,
    thinking: "off" as const,
  };
  const run = async (text: string, conversationId?: string) => {
    const view = await service.send({
      text,
      conversationId,
      requestId: randomUUID(),
      selection,
    });
    await expect
      .poll(
        () =>
          events.some(
            (event) => event.type === "run_end" && event.runId === view.runId,
          ),
        { timeout: 15000 },
      )
      .toBe(true);
    return view;
  };
  const today = dayKey(new Date());
  const request: OverviewRequest = {
    start: today,
    end: today,
    previous: { start: "2000-01-01", end: "2000-01-01" },
    weekStart: 1,
  };

  let overview = await service.overview(request);
  expect(overview).toMatchObject({ retainedSessions: 0, conversations: [] });

  const first = await run("secret-title plan");
  overview = await service.overview(request);
  expect(overview.usage.total).toBe(140);
  expect(overview.sessions).toMatchObject({
    active: 1,
    created: 1,
    continued: 0,
    runs: 1,
    failedRuns: 0,
  });
  expect(overview.conversations[0]).toMatchObject({
    id: first.id,
    title: "[redacted] plan",
    runs: 1,
    models: [{ provider: "worklens-test", model: fixtureModel.id }],
    days: [today],
  });
  expect(overview.previous).toMatchObject({
    partial: true,
    activeConversations: 0,
  });

  await run("again", first.id);
  overview = await service.overview(request);
  expect(overview.usage.total).toBe(280);
  expect(overview.conversations[0].runs).toBe(2);
  expect(overview.models).toEqual([
    expect.objectContaining({
      provider: "worklens-test",
      model: fixtureModel.id,
      runs: 2,
    }),
  ]);
});
