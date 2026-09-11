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
        },
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
  await expect(page.locator(".usage-total")).toHaveText("Total3.86Mtokens");
  const trigger = page.getByRole("button", {
    name: "Open current usage details",
  });
  await expect(trigger).toContainText("Current8.2k tokens·$0.03 est.");
  await expect(page.locator(".run-status")).toBeVisible();
  for (const width of [1440, 1024, 850, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await trigger.click();
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
    await page.keyboard.press("Escape");
    await expect(page.locator(".usage-popover")).toBeHidden();
    await expect(trigger).toBeFocused();
  }
  await trigger.press("Enter");
  await expect(page.locator(".usage-popover")).toBeVisible();
  await page.locator(".chat-header h1").click();
  await expect(page.locator(".usage-popover")).toBeHidden();
});

test("latest completed run keeps usage and marks lifecycle; legacy never falls back to conversation", async ({
  page,
}) => {
  await fixture(page, { completed: true });
  await expect(page.locator(".usage-live-dot")).toHaveCount(0);
  await page.locator(".usage-trigger").click();
  await expect(page.getByTestId("run-usage")).toContainText("Last run");
  await expect(page.getByTestId("run-usage")).toContainText("Completed");
  await page.close();
});

test("legacy unknown run remains inspectable", async ({ page }) => {
  await fixture(page, { legacy: true });
  await expect(page.locator(".usage-trigger")).toContainText("Current—");
  await expect(page.locator(".usage-trigger")).not.toContainText("44.1k");
  await page.locator(".usage-trigger").click();
  await expect(page.getByTestId("run-usage")).toContainText("No recorded run");
  await expect(page.getByTestId("conversation-usage")).toContainText("44.1k");
});

test("partial independent costs, unknown context, reasoning, dark Chinese", async ({
  page,
}, info) => {
  await fixture(page, { partial: true, dark: true, zh: true });
  await expect(page.locator(".usage-total")).toHaveText("总用量3.86M+tokens");
  await expect(page.locator(".usage-trigger")).not.toContainText("$");
  await page.locator(".usage-trigger").click();
  await expect(page.getByTestId("run-usage")).toContainText("Token 数据不完整");
  await expect(page.getByTestId("conversation-usage")).toContainText(
    "$0.184 部分 · 估算",
  );
  await expect(page.getByTestId("conversation-usage")).not.toContainText(
    "Token 数据不完整",
  );
  await expect(page.locator(".usage-context")).toContainText("暂不可用");
  await expect(page.getByRole("progressbar")).toHaveCount(0);
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
  await expect(page.locator(".usage-total")).toHaveText("Total—tokens");
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
  await expect(page.locator(".usage-total strong")).toHaveText("5M");
});
