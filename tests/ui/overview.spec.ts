import { test, expect, type Page } from "@playwright/test";
import { mockWorklens } from "./fixture.js";

// Serves an overview whose trend has the given number of days.
async function openInsights(page: Page, days: number) {
  await mockWorklens(page);
  await page.addInitScript((days) => {
    const usage = (total: number) => ({
      status: "complete",
      input: total,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total,
      cost: { status: "unavailable", source: "unknown" },
    });
    const day = (index: number) =>
      `2026-10-${String(28 - days + 1 + index).padStart(2, "0")}`;
    const trend = Array.from({ length: days }, (_, index) => ({
      start: day(index),
      end: day(index),
      usage: usage(400000 + index * 1000),
      runs: 3,
    }));
    const overview = {
      range: { start: day(0), end: day(days - 1) },
      scope: "retained-local-sessions",
      retainedSessions: 1,
      unreadableSessions: 0,
      usage: usage(400000 * days),
      granularity: "day",
      trend,
      activity: Array.from({ length: 7 }, () =>
        Array.from({ length: 24 }, () => ({ tokens: 0, runs: 0 })),
      ),
      activeDays: trend.map((item) => item.start),
      sessions: { created: 1, active: 1, continued: 0, runs: 3, failedRuns: 0 },
      models: [
        { provider: "deepseek", model: "flash", runs: 3, usage: usage(4e5) },
      ],
      tools: [{ name: "bash", calls: 2 }],
      topics: [
        {
          id: "other",
          source: "other",
          tokens: 400000,
          conversationIds: ["one"],
        },
      ],
      conversations: [
        {
          id: "one",
          title: "Weekly report",
          topicId: "other",
          models: [{ provider: "deepseek", model: "flash" }],
          runs: 3,
          usage: usage(400000),
          lastAt: "2026-10-28T09:00:00Z",
          days: trend.map((item) => item.start),
        },
      ],
    };
    const invoke = (window as any).worklens.invoke;
    (window as any).worklens.invoke = async (name: string, input: any) => {
      if (name === "overview") return overview;
      if (name === "reportSummary") return { stale: false, conversations: 1 };
      const result = await invoke(name, input);
      // Summaries are set up, so the first-visit setup dialog stays closed.
      if (name === "bootstrap")
        result.settings.reportSummary = {
          enabled: true,
          models: [{ provider: "deepseek", model: "flash" }],
        };
      return result;
    };
  }, days);
  await page.goto("/");
  await page.getByRole("button", { name: "Insights", exact: true }).click();
  await expect(page.locator(".overview-trend-bar")).toHaveCount(days);
}

// The activity chart shares the hit-area class, so stay inside the trend.
const trend = (page: Page, selector: string) =>
  page.locator(`.overview-card[data-area="trend"] ${selector}`);
const width = (page: Page, selector: string) =>
  trend(page, selector)
    .first()
    .evaluate((node) => {
      return (node as SVGGraphicsElement).getBBox().width;
    });

test("a single day's highlight stays near its bar", async ({ page }) => {
  await openInsights(page, 1);
  await trend(page, ".overview-hit").hover();
  const band = trend(page, '.overview-hover-band[data-active="true"]');
  await expect(band).toHaveCount(1);
  const bar = await width(page, ".overview-trend-bar");
  const highlight = await width(
    page,
    '.overview-hover-band[data-active="true"]',
  );
  const plot = await width(page, ".overview-hit");
  expect(highlight).toBeLessThanOrEqual(bar * 2 + 0.5);
  expect(highlight).toBeLessThan(plot / 4);
});

test("a dense range's highlight fills its day", async ({ page }) => {
  await openInsights(page, 28);
  await trend(page, ".overview-hit").nth(10).hover();
  const highlight = await width(
    page,
    '.overview-hover-band[data-active="true"]',
  );
  const day = await width(page, ".overview-hit");
  expect(highlight).toBeCloseTo(day - 2, 0);
});

// A second rounded clip around the WebGL effect renders the corners jagged,
// so only the card itself may round the summary's decoration.
test("only the card rounds the summary's decoration", async ({ page }) => {
  await openInsights(page, 7);
  const card = page.locator('.overview-card[data-area="insight"]');
  await expect(card).toHaveCSS("overflow", "hidden");
  const layer = card.locator(".overview-insight-layer");
  await expect(layer).toHaveCSS("overflow", "visible");
  await expect(layer).toHaveCSS("border-radius", "0px");
});
