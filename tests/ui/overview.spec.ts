import { test, expect, type Page } from "@playwright/test";
import { mockWorklens } from "./fixture.js";

// Serves an overview whose trend has the given number of days.
async function openInsights(
  page: Page,
  days: number,
  options: {
    summary?: boolean;
    modelName?: string;
    language?: string;
    theme?: string;
    focusAreas?: { title: string; description: string }[];
    /** The saved summary's one theme names these conversations instead. */
    themeIds?: string[];
    /** Summaries not set up yet, so the setup dialog asks. */
    firstVisit?: boolean;
  } = {},
) {
  await mockWorklens(page);
  await page.addInitScript(
    ({ days, options }) => {
      if (options.language)
        localStorage.setItem("worklens.language", options.language);
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
        sessions: {
          created: 1,
          active: 1,
          continued: 0,
          runs: 3,
          failedRuns: 0,
        },
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
      if (options.focusAreas) {
        const conversation = overview.conversations[0];
        overview.conversations = options.focusAreas.map((area, index) => ({
          ...conversation,
          id: `focus-${index}`,
          title: area.title,
        }));
        overview.retainedSessions = overview.conversations.length;
        overview.sessions.created = overview.conversations.length;
        overview.sessions.active = overview.conversations.length;
      }
      const invoke = (window as any).worklens.invoke;
      (window as any).worklens.invoke = async (name: string, input: any) => {
        if (name === "overview") return overview;
        if (name === "reportSummary")
          return {
            stale: false,
            conversations: overview.conversations.length,
            summary: options.summary
              ? {
                  ...overview.range,
                  summary: `Reviewed ${"a".repeat(300)}`,
                  highlights: ["b".repeat(300), "Checked the layout"],
                  themes: options.themeIds
                    ? [
                        {
                          title: "Old theme",
                          description: "",
                          conversationIds: options.themeIds,
                        },
                      ]
                    : (options.focusAreas ?? []).map((area, index) => ({
                        ...area,
                        conversationIds: [`focus-${index}`],
                      })),
                  model: { provider: "deepseek", model: "flash" },
                  usage: usage(12345),
                  generatedAt: "2026-10-28T09:00:00Z",
                  fingerprint: "fixture",
                }
              : undefined,
          };
        const result = await invoke(name, input);
        // Summaries are set up, so the first-visit setup dialog stays closed.
        if (name === "bootstrap") {
          if (options.theme) result.settings.theme = options.theme;
          if (options.modelName)
            result.providers[0].models[0].name = options.modelName;
          if (!options.firstVisit)
            result.settings.reportSummary = {
              enabled: true,
              models: [{ provider: "deepseek", model: "flash" }],
            };
        }
        return result;
      };
    },
    { days, options },
  );
  await page.goto("/");
  await page.getByRole("button", { name: /^(Insights|洞察)$/ }).click();
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

const longModelName = "DeepSeek V4 Flash Extended Context Preview 2026-10-28";

const securityArea = {
  title: "Security door purchase questions",
  description: "Concerns about sound insulation and door-edge grouting.",
};

for (const appearance of [
  { language: "en", theme: "light" },
  { language: "zh", theme: "dark" },
]) {
  test(`a single focus area keeps its highlight and click target near its content (${appearance.theme})`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openInsights(page, 7, {
      ...appearance,
      summary: true,
      focusAreas: [securityArea],
    });
    const card = page.locator('.overview-card[data-area="topics"]');
    const grid = card.locator(".overview-topics");
    const topic = card.locator(".overview-topic");
    await topic.scrollIntoViewIfNeeded();
    const block = (await topic.boundingBox())!;
    const row = (await grid.boundingBox())!;
    expect(block.width).toBeLessThanOrEqual(360);
    expect(block.width).toBeLessThan(row.width / 2);
    expect(block.x).toBeCloseTo(row.x, 0);
    await expect(topic).toHaveAttribute("aria-pressed", "false");
    await topic.hover();
    await expect(topic).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await card.screenshot({
      path: testInfo.outputPath("focus-area-hover.png"),
    });

    const empty = { x: row.x + row.width - 16, y: block.y + block.height / 2 };
    await page.mouse.move(empty.x, empty.y);
    await expect(topic).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    expect(
      await page.evaluate(
        ({ x, y }) =>
          document.elementFromPoint(x, y)?.closest(".overview-topic") === null,
        empty,
      ),
    ).toBe(true);
    await page.mouse.click(empty.x, empty.y);
    await expect(page.locator(".overview-drawer")).toHaveCount(0);

    await topic.click();
    await expect(topic).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".overview-drawer-row")).toHaveCount(1);
    await expect(page.locator(".overview-drawer-name")).toHaveText(
      securityArea.title,
    );
    await page.locator(".overview-drawer-head .overview-icon-button").click();
    await expect(topic).toHaveAttribute("aria-pressed", "false");
    await expect(topic).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(topic).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".overview-drawer-row")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(topic).toHaveAttribute("aria-pressed", "false");

    await page.setViewportSize({ width: 850, height: 620 });
    expect((await topic.boundingBox())!.width).toBeLessThanOrEqual(360);
    expect(
      await grid.evaluate((el) => el.scrollWidth - el.clientWidth),
    ).toBeLessThanOrEqual(1);
  });
}

test("multiple focus areas wrap within their columns and disclose long titles", async ({
  page,
}, testInfo) => {
  const longTitle = "API reliability and diagnostics across multiple providers";
  await openInsights(page, 7, {
    summary: true,
    focusAreas: [
      securityArea,
      {
        title: longTitle,
        description: "Reviewed request failures and connection diagnostics.",
      },
      {
        title: "Release planning",
        description: "Checked remaining tasks before the next release.",
      },
      { title: "Layout", description: "Tuned the desktop layout." },
    ],
  });
  const card = page.locator('.overview-card[data-area="topics"]');
  const topics = card.locator(".overview-topic");
  const grid = card.locator(".overview-topics");
  await expect(topics).toHaveCount(4);
  for (const width of [1440, 1024, 850]) {
    await page.setViewportSize({ width, height: 768 });
    const blocks = await topics.evaluateAll((elements) =>
      elements.map((el) => {
        const box = el.getBoundingClientRect();
        return {
          x: box.x,
          y: box.y,
          right: box.right,
          bottom: box.bottom,
          width: box.width,
          overflow: el.scrollWidth - el.clientWidth,
        };
      }),
    );
    const row = (await grid.boundingBox())!;
    for (const block of blocks) {
      expect(block.width).toBeLessThanOrEqual(360);
      expect(block.overflow).toBeLessThanOrEqual(1);
      expect(block.right).toBeLessThanOrEqual(row.x + row.width + 1);
    }
    for (let i = 0; i < blocks.length; i++)
      for (let j = i + 1; j < blocks.length; j++)
        expect(
          blocks[i].right <= blocks[j].x || blocks[i].bottom <= blocks[j].y,
        ).toBe(true);
    if (width === 850) expect(blocks[3].y).toBeGreaterThan(blocks[0].y);
  }
  const title = topics.nth(1).locator(".truncate");
  expect(await title.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(
    true,
  );
  const hint = page.locator('[data-slot="tooltip-content"][data-open]');
  await topics.nth(1).hover();
  await expect(hint).toHaveText(longTitle);
  await page.mouse.move(0, 0);
  await topics.nth(1).focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(topics.nth(1)).toBeFocused();
  await expect(hint).toHaveText(longTitle);
  await page.keyboard.press("Escape");
  await card.screenshot({
    path: testInfo.outputPath("focus-areas-narrow.png"),
  });
  await page.locator(".sidebar-toggle").click();
  expect(
    await grid.evaluate((el) => el.scrollWidth - el.clientWidth),
  ).toBeLessThanOrEqual(1);
});

for (const appearance of [
  { language: "en", theme: "light" },
  { language: "zh", theme: "dark" },
]) {
  test(`summary text adapts to resizing (${appearance.language}, ${appearance.theme})`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openInsights(page, 7, {
      ...appearance,
      summary: true,
      modelName: longModelName,
    });
    const meta = page.locator(".overview-summary-meta");
    const label = meta.locator(".truncate");
    const details = meta.locator(".overview-summary-details");
    const card = page.locator('.overview-card[data-area="insight"]');
    await expect(label).toHaveText(longModelName);
    // This width uses the compact card in the three-card row.
    await expect
      .poll(() => label.evaluate((el) => el.scrollWidth > el.clientWidth))
      .toBe(true);
    const compactNameWidth = await label.evaluate((el) => el.clientWidth);

    const checkLayout = async () => {
      const metrics = await meta.evaluate((el) => {
        const [label, details] = [...el.children];
        const row = el.getBoundingClientRect();
        const name = label.getBoundingClientRect();
        const rest = details.getBoundingClientRect();
        return {
          height: row.height,
          lineHeight: parseFloat(getComputedStyle(el).lineHeight),
          overflow: el.scrollWidth - el.clientWidth,
          overlap: name.right - rest.left,
          right: rest.right - row.right,
        };
      });
      expect(metrics.height).toBeLessThanOrEqual(metrics.lineHeight + 1);
      expect(metrics.overflow).toBeLessThanOrEqual(1);
      expect(metrics.overlap).toBeLessThanOrEqual(0);
      expect(metrics.right).toBeLessThanOrEqual(1);
      const body = page.locator(".overview-summary-body");
      expect(
        await body.evaluate((el) => el.scrollWidth - el.clientWidth),
      ).toBeLessThanOrEqual(1);
      await expect(details).toContainText(
        appearance.language === "en" ? "tokens" : "token",
      );
    };
    await checkLayout();
    await meta.hover();
    await expect(page.locator('[data-slot="tooltip-content"]')).toContainText(
      longModelName,
    );
    await page.mouse.move(0, 0);
    await meta.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(meta).toBeFocused();
    await expect(page.locator('[data-slot="tooltip-content"]')).toContainText(
      longModelName,
    );
    await page.keyboard.press("Escape");
    await card.screenshot({ path: testInfo.outputPath("summary-compact.png") });

    // Widening within the same three-card layout reveals more of the name.
    await page.setViewportSize({ width: 1680, height: 900 });
    await expect
      .poll(() => label.evaluate((el) => el.clientWidth))
      .toBeGreaterThan(compactNameWidth);
    await checkLayout();

    // At this width the summary occupies its own row, revealing the full name.
    await page.setViewportSize({ width: 1100, height: 768 });
    await expect
      .poll(() => label.evaluate((el) => el.scrollWidth <= el.clientWidth))
      .toBe(true);
    await checkLayout();
    await card.screenshot({
      path: testInfo.outputPath("summary-expanded.png"),
    });
    // Wider again: the layout returns to three cards and the name truncates.
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect
      .poll(() => label.evaluate((el) => el.scrollWidth > el.clientWidth))
      .toBe(true);
    await page.locator(".sidebar-toggle").click();
    await checkLayout();
    await page.setViewportSize({ width: 860, height: 600 });
    await checkLayout();
    expect(
      await card.evaluate((el) => el.scrollWidth - el.clientWidth),
    ).toBeLessThanOrEqual(1);
  });
}

test("the first visit asks once, and turning summaries on starts with the chat model", async ({
  page,
}) => {
  await openInsights(page, 7, { firstVisit: true });
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Summarize your work with AI?" }),
  ).toBeVisible();
  // A question with two answers, not settings to work through.
  await expect(dialog.getByRole("switch")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Turn on", exact: true }).click();

  await expect(
    dialog.getByRole("heading", { name: "AI summary" }),
  ).toBeVisible();
  await expect(dialog.getByRole("switch")).toBeChecked();
  await expect(dialog.locator(".report-settings-model")).toHaveCount(1);
  await expect(
    dialog.locator(".report-settings-model > .truncate").first(),
  ).toHaveText("DeepSeek V4 Flash");
  const saved = await page.evaluate(() =>
    (window as any).calls.filter((call: any) => call.name === "settings"),
  );
  expect(saved.at(-1).input).toEqual({
    reportSummary: {
      enabled: true,
      models: [{ provider: "deepseek", model: "flash" }],
    },
  });
  // The models and the switch's hint start at the same edge.
  const edge = async (selector: string) =>
    (await dialog.locator(selector).first().boundingBox())!.x;
  expect(
    Math.abs(
      (await edge(".report-settings-heading > div")) -
        (await edge("#report-summary-hint")),
    ),
  ).toBeLessThanOrEqual(1);
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test("skipping the first-visit question keeps summaries off and leaves the settings in the header", async ({
  page,
}) => {
  await openInsights(page, 7, { firstVisit: true });
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Not now", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("ui-fixture-settings") ?? "{}")
            .reportSummary,
      ),
    )
    .toEqual({ enabled: false, models: [] });
  await page
    .getByRole("button", { name: "AI summary settings", exact: true })
    .click();
  await expect(
    dialog.getByRole("heading", { name: "AI summary" }),
  ).toBeVisible();
  await expect(dialog.getByRole("switch")).not.toBeChecked();
  await expect(
    dialog.getByRole("button", { name: "Not now", exact: true }),
  ).toHaveCount(0);
});

test("summary settings reveal long model names without squeezing the controls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 600 });
  await openInsights(page, 7, { modelName: longModelName });
  await page
    .getByRole("button", { name: "AI summary settings", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  const label = dialog.locator(".report-settings-model > .truncate").first();
  await expect(label).toHaveText(longModelName);
  await expect
    .poll(() => label.evaluate((el) => el.scrollWidth > el.clientWidth))
    .toBe(true);
  await label.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(label).toBeFocused();
  await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText(
    longModelName,
  );
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await dialog.locator(".report-settings-thinking").click();
  await expect(
    page.getByRole("menuitemradio", { name: "High", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  const model = dialog.locator(".report-settings-model");
  const actions = dialog.locator(".report-settings-actions");
  const bounds = await model.boundingBox();
  const buttons = await actions.boundingBox();
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(buttons!.x);
});

test("short model names show no hint, and the summary separator is evenly spaced", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openInsights(page, 7, { summary: true });
  const meta = page.locator(".overview-summary-meta");
  const label = meta.locator(".truncate");
  const hint = page.locator('[data-slot="tooltip-content"]');
  expect(await label.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(
    false,
  );
  const spacing = await meta.evaluate((el) => {
    const [label, details] = [...el.children];
    const text = details.firstChild!;
    const glyph = (start: number) => {
      const range = document.createRange();
      range.setStart(text, start);
      range.setEnd(text, start + 1);
      return range.getBoundingClientRect();
    };
    const dot = glyph(0);
    return {
      before: dot.left - label.getBoundingClientRect().right,
      after: glyph(2).left - dot.right,
    };
  });
  expect(spacing.before).toBeGreaterThan(0);
  expect(Math.abs(spacing.before - spacing.after)).toBeLessThanOrEqual(1);

  await meta.hover();
  await page.waitForTimeout(800);
  await expect(hint).toHaveCount(0);
  await page.mouse.move(0, 0);
  await meta.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(meta).toBeFocused();
  await page.waitForTimeout(800);
  await expect(hint).toHaveCount(0);

  await page
    .getByRole("button", { name: "AI summary settings", exact: true })
    .click();
  const name = page
    .getByRole("dialog")
    .locator(".report-settings-model > .truncate")
    .first();
  await name.hover();
  await page.waitForTimeout(800);
  await expect(hint).toHaveCount(0);
  // A hint that declines to open must not consume the dialog's Escape.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

// A summary kept from an earlier range may name only conversations that are
// no longer in it; the range's own topics then fill the focus areas.
for (const [ids, shown] of [
  [["one"], "Old theme"],
  [["gone"], "Other"],
] as const)
  test(`focus areas from a summary naming ${ids[0]} show ${shown}`, async ({
    page,
  }) => {
    await openInsights(page, 7, { summary: true, themeIds: [...ids] });
    const topics = page.locator('.overview-card[data-area="topics"]');
    await expect(topics).toContainText(shown);
    await expect(topics).not.toContainText(
      shown === "Old theme" ? "Other" : "Old theme",
    );
  });
