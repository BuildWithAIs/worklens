import { test, expect } from "@playwright/test";
import { mockWorklens } from "./fixture.js";

async function fixture(page, options = {}) {
  await mockWorklens(page);
  await page.addInitScript((options) => {
    localStorage.setItem("worklens.language", options.zh ? "zh" : "en");
    const usage = {
      status: "complete",
      total: 44100,
      input: 25600,
      output: 8000,
      cacheRead: 9200,
      cacheWrite: 1300,
      cost: { status: "complete", usd: 0.184, source: "pi-estimate" },
    };
    const selection = {
      provider: "deepseek",
      model: "flash",
      thinking: "high",
    };
    const view = {
      id: "usage",
      title: "Refactor auth service",
      phase: "generating",
      selection,
      runId: "run-1",
      revision: 1,
      updatedAt: new Date().toISOString(),
      messages: [
        {
          id: "user",
          role: "user",
          text: "Refactor the authentication service and make provider errors easier to understand.",
        },
        {
          id: "assistant",
          role: "assistant",
          text: "I reviewed the provider and authentication flow. I’ll keep the existing credential boundary intact and simplify error classification in the main process.",
        },
      ],
      usage: {
        conversation: usage,
        run: {
          ...usage,
          total: 8200,
          cost: { status: "complete", usd: 0.031, source: "pi-estimate" },
          runId: "run-1",
          state: "active",
          selection,
          elapsedMs: 2800,
        },
        context: {
          status: "complete",
          tokens: 68000,
          contextWindow: 200000,
          percent: 34,
          compactAt: 183616,
          segments: [
            { id: "system", kind: "system", tokens: 14000 },
            { id: "turn:1", kind: "history", tokens: 12000 },
            { id: "turn:2", kind: "history", tokens: 9000 },
            { id: "turn:3", kind: "history", tokens: 15000 },
            { id: "turn:4", kind: "history", tokens: 8000 },
            { id: "turn:5", kind: "turn", tokens: 10000 },
          ],
        },
        cacheSavingsUsd: 0.025,
      },
    };
    const global = {
      status: "complete",
      totalTokens: 3860000,
      scope: "retained-local-sessions",
      sessionCount: 19,
      readableSessionCount: 19,
      unavailableSessionCount: 0,
      revision: 1,
    };
    if (options.completed) {
      view.phase = "completed";
      view.usage.run.state = "completed";
    }
    if (options.legacy) {
      delete view.usage.run;
      view.phase = "idle";
    }
    if (options.partial) {
      global.status = "partial";
      view.usage.run.status = "partial";
      view.usage.run.cost.status = "partial";
      view.usage.conversation.cost.status = "partial";
      view.usage.conversation.reasoning = 3000;
      view.usage.context = { status: "unavailable", contextWindow: 200000 };
    }
    if (options.unavailable) {
      global.status = "unavailable";
      delete global.totalTokens;
      view.usage.run = undefined;
    }
    // Tests change the live view, then publish it with usageEmit.
    window.usageView = view;
    let listener;
    window.worklens.onChat = (fn) => {
      listener = fn;
      return () => {};
    };
    window.usageEmit = (
      revision,
      totalTokens,
      sequence = revision,
      type = "message_end",
    ) =>
      listener({
        conversationId: view.id,
        runId: "run-1",
        type,
        sequence,
        view: { ...structuredClone(view), revision: sequence },
        globalUsage: { ...global, revision, totalTokens },
      });
    const invoke = window.worklens.invoke;
    window.worklens.invoke = async (name, input) => {
      if (name === "open") return structuredClone(view);
      const result = await invoke(name, input);
      if (name === "bootstrap") {
        Object.assign(result, {
          conversations: [view],
          globalUsage: { ...global },
        });
        result.settings.lastConversation = view.id;
        result.settings.theme = options.dark ? "dark" : "light";
        if (options.bootstrapRace) window.usageEmit(10, 5000000);
      }
      return result;
    };
  }, options);
  await page.goto("/");
  await expect(page.locator(".chat-header h1")).toHaveText(
    "Refactor auth service",
  );
}

test("prototype header, popover, keyboard and desktop layout", async ({
  page,
}, info) => {
  await fixture(page);
  await expect(page.locator(".usage-total")).toHaveCount(0);
  const trigger = page.getByRole("button", {
    name: "Open current usage details",
  });
  await expect(trigger).toContainText("34%");
  await expect(trigger).toHaveCSS("border-top-width", "0px");
  await expect(trigger.locator(".lucide-chevron-down")).toBeVisible();
  await expect(page.locator(".run-status")).toHaveCount(0);
  for (const width of [1440, 1024, 850, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await trigger.click();
    await expect(page.locator(".usage-popover")).toBeVisible();
    await page.mouse.move(0, 0);
    await expect(page.locator(".usage-popover")).toBeVisible();
    await expect(
      page.getByRole("progressbar", { name: "Context usage" }),
    ).toHaveAttribute("aria-valuenow", "34");
    await expect(page.getByTestId("run-usage")).toContainText("Current run");
    await expect(page.getByTestId("conversation-usage")).toContainText("44.1k");
    await expect(page.locator(".usage-popover")).not.toContainText(
      /5-hour|weekly|quota/i,
    );
    const box = await page.locator(".usage-popover").boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath(`usage-${width}.png`),
      fullPage: true,
    });
    const overviewHeight = box.height;
    const dividerY = (await page.locator(".usage-model").boundingBox()).y;
    const modelText = await page.locator(".usage-model strong").boundingBox();
    await page.getByRole("tab", { name: "Details", exact: true }).click();
    await expect(page.getByRole("tabpanel", { name: "Details", exact: true })).toContainText("All models total");
    expect((await page.locator(".usage-popover").boundingBox()).height).toBe(overviewHeight);
    expect(overviewHeight).toBeLessThanOrEqual(320);
    expect(Math.abs((await page.locator(".usage-total").boundingBox()).y - dividerY)).toBeLessThanOrEqual(1);
    const totalText = await page.locator(".usage-total strong").boundingBox();
    expect(Math.abs(totalText.y + totalText.height / 2 - modelText.y - modelText.height / 2)).toBeLessThanOrEqual(1);
    expect(await page.getByRole("tabpanel", { name: "Details", exact: true }).evaluate(el => el.scrollHeight <= el.clientHeight)).toBe(true);
    await expect(page.locator(".usage-cost-note")).toHaveCount(0);
    await expect(page.locator(".usage-composition > span")).toHaveCount(4);
    await page.screenshot({path: info.outputPath(`usage-details-${width}.png`)});
    await page.getByRole("tab", { name: "Details", exact: true }).press("ArrowLeft");
    await expect(page.getByRole("tab", { name: "Overview", exact: true })).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Escape");
    await expect(page.locator(".usage-popover")).toBeHidden();
    await expect(trigger).toBeFocused();
  }
  await trigger.press("Enter");
  await expect(page.locator(".usage-popover")).toBeVisible();
  // At renderer stress widths the title may have no room beside header controls.
  await page.mouse.click(10, 500);
  await expect(page.locator(".usage-popover")).toBeHidden();
});

test("latest completed run keeps usage and marks lifecycle; legacy never falls back to conversation", async ({
  page,
}) => {
  await fixture(page, { completed: true });
  await expect(page.locator(".usage-live-dot")).toHaveCount(0);
  await page.locator(".usage-trigger").click();
  // A completed run is described by its row: label, duration and state.
  await expect(page.getByTestId("run-usage").locator("th")).toHaveText(
    "Last run · 2.8s",
  );
  await expect(page.getByTestId("run-usage").locator("th")).toHaveAttribute(
    "aria-label",
    "Last run · Completed · 2.8s",
  );
  await expect(page.locator(".usage-run-state")).toHaveCount(0);
  await page.close();
});

test("legacy unknown run remains inspectable", async ({ page }) => {
  await fixture(page, { legacy: true });
  await expect(page.locator(".usage-trigger")).toContainText("34%");
  await expect(page.locator(".usage-trigger")).not.toContainText("44.1k");
  await page.locator(".usage-trigger").click();
  await expect(page.getByTestId("run-usage")).toContainText("—");
  await expect(page.locator(".usage-run-state")).toContainText("No recorded run");
  await expect(page.getByTestId("conversation-usage")).toContainText("44.1k");
});

test("partial independent costs, unknown context, reasoning, dark Chinese", async ({
  page,
}, info) => {
  await fixture(page, { partial: true, dark: true, zh: true });
  await expect(page.locator(".usage-trigger")).toHaveText("—");
  await expect(page.locator(".usage-trigger")).not.toContainText("$");
  await page.locator(".usage-trigger").click();
  await expect(page.locator(".usage-notice")).toContainText("Token 数据不完整");
  // Every shown cost is an estimate, so the header says so once.
  await expect(page.getByTestId("conversation-usage")).toContainText(
    "$0.184+",
  );
  await expect(page.locator(".usage-summary thead")).toContainText("费用 ≈");
  await expect(page.getByTestId("conversation-usage")).not.toContainText(
    "Token 数据不完整",
  );
  await page.getByTestId("conversation-usage").locator("td").last().hover();
  await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(0);
  await expect(page.locator(".usage-context")).toContainText("暂不可用");
  await expect(page.getByRole("progressbar")).toHaveCount(0);
  await page.getByRole("tab", { name: "明细", exact: true }).click();
  await expect(page.locator(".usage-total")).toHaveText("所有模型累计3.86M+tokens");
  await page.locator(".usage-total strong").hover();
  await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(0);
  await page.getByRole("button", { name: "关于累计用量" }).hover();
  await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText("所有保留的本地会话 · 数据不完整");
  await page.mouse.move(0, 0);
  await expect(page.locator(".usage-breakdown")).toContainText(
    "推理 · 包含在输出中",
  );
  await page.screenshot({
    path: info.outputPath("usage-dark-zh.png"),
    fullPage: true,
  });
});

test("unavailable total and old live events never masquerade as zero or roll global back", async ({
  page,
}) => {
  await fixture(page, { unavailable: true });
  await page.locator(".usage-trigger").click();
  await page.getByRole("tab", { name: "Details", exact: true }).click();
  await expect(page.locator(".usage-total")).toHaveText("All models total—tokens");
  await page.evaluate(() => window.usageEmit(10, 4000000));
  await expect(page.locator(".usage-total strong")).toHaveText("4M");
  await page.evaluate(() => window.usageEmit(9, 3000000, 11));
  await expect(page.locator(".usage-total strong")).toHaveText("4M");
  // Even a deduplicated run event can carry a newer global revision.
  await page.evaluate(() => window.usageEmit(12, 5000000, 10));
  await expect(page.locator(".usage-total strong")).toHaveText("5M");
});

test("live global arriving before first bootstrap is retained", async ({
  page,
}) => {
  await fixture(page, { bootstrapRace: true });
  await page.locator(".usage-trigger").click();
  await page.getByRole("tab", { name: "Details", exact: true }).click();
  await expect(page.locator(".usage-total strong")).toHaveText("5M");
});


test("usage popover stays above the header fade", async ({ page }) => {
  await fixture(page);
  await page.getByRole("button", { name: "Open current usage details" }).click();
  const popup = page.locator(".usage-popover");
  await expect(popup).toBeVisible();
  const layers = await popup.evaluate(node => ({
    popup: Number(getComputedStyle(node.parentElement).zIndex),
    header: Number(getComputedStyle(document.querySelector(".chat-header")).zIndex),
  }));
  expect(layers.popup).toBeGreaterThan(layers.header);
});

test.describe("context composition animation", () => {
  test.use({ reducedMotion: "no-preference" });
  const segment = (page, id) =>
    page.locator(`.usage-popover [data-segment="${id}"]`);
  const width = (locator) =>
    locator.evaluate((element) => element.getBoundingClientRect().width);
  const emit = (page, change, sequence) =>
    page.evaluate(
      ({ change, sequence }) => {
        const view = window.usageView;
        if (change.phase) view.phase = change.phase;
        if (change.context)
          view.usage.context = { ...view.usage.context, ...change.context };
        window.usageEmit(sequence, 3860000, sequence);
      },
      { change, sequence },
    );

  test("a new turn grows in while the previous one becomes history", async ({
    page,
  }, info) => {
    await fixture(page);
    const trigger = page.getByRole("button", {
      name: "Open current usage details",
    });
    await trigger.click();
    const bar = page.getByRole("progressbar", { name: "Context usage" });
    await expect(bar).toHaveAttribute(
      "aria-valuetext",
      /System prompt and tools 14k, Earlier turns 12k/,
    );
    await expect(page.locator(".usage-context .usage-legend")).toHaveText(
      "System14kEarlier44kLatest10k",
    );
    // 183.6k threshold minus 68k used.
    await expect(page.locator(".usage-compact-caption")).toHaveText(
      "Auto-compacts in 115.6k",
    );
    await emit(
      page,
      {
        context: {
          tokens: 80000,
          percent: 40,
          segments: [
            { id: "system", kind: "system", tokens: 14000 },
            { id: "turn:1", kind: "history", tokens: 12000 },
            { id: "turn:2", kind: "history", tokens: 9000 },
            { id: "turn:3", kind: "history", tokens: 15000 },
            { id: "turn:4", kind: "history", tokens: 8000 },
            { id: "turn:5", kind: "history", tokens: 10000 },
            { id: "turn:6", kind: "turn", tokens: 12000 },
          ],
        },
      },
      2,
    );
    // The same element changes kind, so its color can transition.
    await expect(segment(page, "turn:5")).toHaveAttribute(
      "data-kind",
      "history",
    );
    const grown = segment(page, "turn:6");
    await expect(grown).toHaveAttribute("data-kind", "turn");
    const early = await width(grown);
    await page.waitForTimeout(700);
    const final = await width(grown);
    expect(early).toBeLessThan(final);
    // 12k of a 200k window on a ~300px track.
    expect(final).toBeGreaterThan(14);
    await expect(trigger).toContainText("40%");
    await page.screenshot({ path: info.outputPath("context-grown.png") });
  });

  test("compaction sweeps history into a summary and collapses the bar", async ({
    page,
  }, info) => {
    await fixture(page);
    const trigger = page.getByRole("button", {
      name: "Open current usage details",
    });
    await trigger.click();
    await emit(page, { phase: "compacting" }, 2);
    const bar = page.locator(".usage-popover .usage-context-bar");
    await expect(bar).toHaveAttribute("data-compacting", "true");
    await expect(trigger).toContainText("Compacting…");
    await page.waitForTimeout(900);
    // History blocks turn summary-green one after another.
    const summaryColor = await page
      .locator(".usage-popover")
      .evaluate((element) =>
        getComputedStyle(element).getPropertyValue("--context-summary").trim(),
      );
    expect(summaryColor).toBe("#1f9a6a");
    await expect(segment(page, "turn:3")).toHaveCSS(
      "background-color",
      "rgb(31, 154, 106)",
    );
    // The latest turn is kept by compaction, so it keeps its own color.
    await expect(segment(page, "turn:5")).toHaveCSS(
      "background-color",
      "rgb(47, 111, 209)",
    );
    await page.screenshot({ path: info.outputPath("context-compacting.png") });

    // Pi cannot report the size until the next reply; segments estimate it.
    await emit(
      page,
      {
        phase: "generating",
        context: {
          status: "unavailable",
          tokens: undefined,
          percent: undefined,
          segments: [
            { id: "system", kind: "system", tokens: 14000 },
            { id: "summary:9", kind: "summary", tokens: 3000 },
          ],
        },
      },
      3,
    );
    await expect(bar).not.toHaveAttribute("data-compacting", "true");
    await expect(segment(page, "turn:3")).toHaveAttribute(
      "data-exiting",
      "true",
    );
    await expect(segment(page, "turn:3")).toHaveCount(0);
    await expect(segment(page, "summary:9")).toHaveAttribute(
      "data-kind",
      "summary",
    );
    await expect(trigger).toContainText("≈8.5%");
    await expect(page.locator(".usage-context-labels")).toContainText(
      "≈17k / 200k",
    );
    await page.screenshot({ path: info.outputPath("context-compacted.png") });
  });

  test("approaching the threshold is flagged in the header", async ({
    page,
  }) => {
    await fixture(page);
    await emit(
      page,
      {
        context: {
          tokens: 170000,
          percent: 85,
          segments: [
            { id: "system", kind: "system", tokens: 14000 },
            { id: "turn:1", kind: "history", tokens: 140000 },
            { id: "turn:2", kind: "turn", tokens: 16000 },
          ],
        },
      },
      2,
    );
    const trigger = page.getByRole("button", {
      name: "Open current usage details",
    });
    await expect(trigger).toHaveAttribute("data-near", "true");
    await expect(trigger.locator("> span")).toHaveCSS(
      "color",
      "rgb(161, 98, 7)",
    );
  });
});

test("details show the cache hit rate and approximate savings", async ({
  page,
}) => {
  await fixture(page);
  await page
    .getByRole("button", { name: "Open current usage details" })
    .click();
  await page.getByRole("tab", { name: "Details", exact: true }).click();
  // 9.2k cache reads of 36.1k input tokens.
  await expect(page.getByTestId("cache-usage")).toHaveText("Cache hit rate25%");
  await expect(page.getByTestId("cache-savings")).toHaveText(
    "Saved by cache≈ $0.025",
  );
  await expect(page.locator(".usage-breakdown-heading")).toHaveText(
    "Token breakdownThis conversation",
  );
});

test("reduced motion shows the final state without exit delays", async ({
  page,
}) => {
  await fixture(page);
  await page
    .getByRole("button", { name: "Open current usage details" })
    .click();
  await page.evaluate(() => {
    const view = window.usageView;
    view.usage.context.segments = [
      { id: "system", kind: "system", tokens: 14000 },
      { id: "summary:9", kind: "summary", tokens: 3000 },
    ];
    window.usageEmit(2, 3860000, 2);
  });
  await expect(page.locator(".usage-popover [data-exiting]")).toHaveCount(0);
  await expect(
    page.locator('.usage-popover [data-segment="turn:3"]'),
  ).toHaveCount(0);
});

test("the threshold is explained with its value and kept out of the header", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    // A large window puts the threshold near the end (window - 16,384).
    Object.assign(window.usageView.usage.context, {
      contextWindow: 500000,
      compactAt: 483616,
      percent: 13.6,
    });
    window.usageEmit(2, 3860000, 2);
  });
  const trigger = page.getByRole("button", {
    name: "Open current usage details",
  });
  await expect(trigger).toContainText("13.6%");
  await expect(trigger.locator(".usage-context-threshold")).toHaveCount(0);
  await trigger.click();
  // One number: how much context is left before compaction runs.
  const caption = page.locator(".usage-compact-caption");
  await expect(caption).toHaveText("Auto-compacts in 415.6k");
  await expect(caption.locator("i")).toBeVisible();
  // The legend sits clearly below the bar, with nothing between them.
  const bar = await page
    .locator(".usage-context .usage-context-track")
    .boundingBox();
  const legend = await page.locator(".usage-context .usage-legend").boundingBox();
  expect(legend.y - (bar.y + bar.height)).toBeGreaterThanOrEqual(8);
  const line = await page.locator(".usage-context-threshold").boundingBox();
  expect(line.y + line.height).toBeLessThan(legend.y);
});

test("overview and details share one bar style and highlight on hover", async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole("button", { name: "Open current usage details" }).click();
  const overview = page.locator(".usage-context");
  await overview.locator('[data-legend="system"]').hover();
  await expect(overview.locator('[data-segment="system"]')).not.toHaveAttribute(
    "data-dim",
  );
  await expect(overview.locator('[data-segment="turn:5"]')).toHaveAttribute(
    "data-dim",
    "true",
  );
  await expect(overview.locator('[data-legend="history"]')).toHaveAttribute(
    "data-dim",
    "true",
  );
  await page.mouse.move(0, 0);
  await expect(overview.locator("[data-dim]")).toHaveCount(0);

  await page.getByRole("tab", { name: "Details", exact: true }).click();
  const details = page.locator(".usage-breakdown");
  // The same track and legend components as the overview.
  await expect(details.locator(".usage-context-track > span")).toHaveCount(4);
  await expect(details.locator(".usage-legend li")).toHaveCount(4);
  await details.locator('[data-segment="cacheRead"]').hover();
  await expect(details.locator('[data-legend="cacheRead"]')).not.toHaveAttribute(
    "data-dim",
  );
  await expect(details.locator('[data-legend="input"]')).toHaveAttribute(
    "data-dim",
    "true",
  );
});

test("overview and details section titles share one text style", async ({
  page,
}) => {
  await fixture(page, { dark: false });
  await page.getByRole("button", { name: "Open current usage details" }).click();
  const style = (selector) =>
    page.locator(selector).evaluate((element) => {
      const computed = getComputedStyle(element);
      return [
        computed.fontSize,
        computed.fontWeight,
        computed.fontFamily,
        computed.color,
      ];
    });
  // Section titles match across tabs.
  const overview = await style(".usage-context-labels > span:first-child");
  await page.getByRole("tab", { name: "Details", exact: true }).click();
  expect(await style(".usage-breakdown-heading > span:first-child")).toEqual(
    overview,
  );
});

test("a partial conversation still shows the composition of known requests", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    // For example, a request stopped before the provider reported usage.
    window.usageView.usage.conversation.status = "partial";
    window.usageEmit(2, 3860000, 2);
  });
  await page.getByRole("button", { name: "Open current usage details" }).click();
  await page.getByRole("tab", { name: "Details", exact: true }).click();
  const details = page.locator(".usage-breakdown");
  await expect(details.locator(".usage-composition > span")).toHaveCount(4);
  await expect(details.locator(".usage-legend")).toHaveText(
    "Input25.6k+Output8k+Cache read9.2k+Cache write1.3k+",
  );
  await expect(details.getByRole("img")).toHaveAttribute(
    "aria-label",
    /Partial token data$/,
  );
});

test("the caption says when compaction is next once past the threshold", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    Object.assign(window.usageView.usage.context, {
      tokens: 190000,
      percent: 95,
    });
    window.usageEmit(2, 3860000, 2);
  });
  await page.getByRole("button", { name: "Open current usage details" }).click();
  await expect(page.locator(".usage-compact-caption")).toHaveText(
    "Auto-compacts before the next message",
  );
});

test("both tabs leave the same space after their bar block", async ({
  page,
}) => {
  await fixture(page, { completed: true });
  await page.getByRole("button", { name: "Open current usage details" }).click();
  const gap = async (above, below) => {
    const a = await page.locator(above).boundingBox();
    const b = await page.locator(below).boundingBox();
    return Math.round(b.y - (a.y + a.height));
  };
  const overview = await gap(".usage-context", ".usage-summary");
  await page.getByRole("tab", { name: "Details", exact: true }).click();
  const details = await gap(".usage-breakdown .usage-legend", ".usage-facts");
  expect(details).toBe(overview);
  expect(overview).toBe(12);
});
