import { test, expect } from "@playwright/test";
import { mockWorklens } from "./fixture.js";

test("history scrolls long titles with hints and marks only unseen completed replies", async ({ page }, testInfo) => {
  await mockWorklens(page);
  await page.addInitScript(() => {
    const invoke = window.worklens.invoke;
    const views = {
      a: { id: "a", title: "A long conversation title that should fade and scroll without an ellipsis at the end", updatedAt: "2026-09-12T01:00:00Z", phase: "generating", messages: [] },
      b: { id: "b", title: "Other history", updatedAt: "2026-09-12T00:00:00Z", phase: "completed", messages: [] },
    };
    let listener;
    window.worklens.onChat = (next) => { listener = next; return () => {}; };
    window.historyEvent = (id, runId, sequence, phase) => {
      views[id] = { ...views[id], phase, runId, revision: sequence };
      listener({ conversationId: id, runId, sequence, type: phase === "generating" ? "run_start" : "run_end", view: structuredClone(views[id]) });
    };
    window.worklens.invoke = async (name, input) => {
      if (name === "open") return structuredClone(views[input.id]);
      const result = await invoke(name, input);
      if (name === "bootstrap") { result.conversations = Object.values(views); result.settings.lastConversation = "a"; }
      return result;
    };
  });
  await page.goto("/");
  const first = page.locator(".conversation-item").filter({ hasText: "A long conversation" });
  const title = first.locator(".history-title-clip");
  await page.locator(".chat-header").hover();
  await expect(first.locator(".conversation-open")).toHaveCSS("padding-right", "36px");
  await expect(title).toHaveAttribute("data-overflow", "true");
  await expect(title).toHaveText("A long conversation title that should fade and scroll without an ellipsis at the end");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await first.locator(".conversation-open").hover();
  await expect(first.locator(".conversation-open")).toHaveCSS("padding-right", "36px");
  await expect(first.locator(".history-title-text")).toHaveCSS("animation-name", "history-title-pan");
  await expect(first.locator(".history-title-text")).toHaveCSS("animation-delay", "0.5s");
  await expect(first.locator(".history-title-text")).toHaveCSS("animation-timing-function", "linear");
  const row = first.locator(".conversation-open");
  const beforePress = await row.boundingBox();
  await page.mouse.down();
  const duringPress = await row.boundingBox();
  expect(duringPress.y).toBe(beforePress.y);
  await page.mouse.up();
  await page.locator(".chat-header").hover();
  await row.hover();
  const positions = await first.locator(".history-title-text").evaluate(node => {
    const animation = node.getAnimations()[0];
    animation.pause();
    const samples = [250, 500, 1000, 1500].map(time => {
      animation.currentTime = time;
      return new DOMMatrix(getComputedStyle(node).transform).m41;
    });
    animation.play();
    return samples;
  });
  expect(positions[0]).toBe(0);
  expect(positions[1]).toBe(0);
  expect(positions[2]).toBeCloseTo(-17.5, 1);
  expect(positions[3]).toBeCloseTo(-35, 1);
  const endPositions = await first.locator(".history-title-text").evaluate(node => {
    const animation = node.getAnimations()[0];
    animation.pause();
    const { delay, duration } = animation.effect.getTiming();
    const end = Number(delay) + Number(duration);
    return [end, end + 1000, end + Number(duration)].map(time => {
      animation.currentTime = time;
      return new DOMMatrix(getComputedStyle(node).transform).m41;
    });
  });
  expect(endPositions[0]).toBeLessThan(0);
  expect(endPositions[1]).toBe(endPositions[0]);
  expect(endPositions[2]).toBe(endPositions[0]);
  await expect(page.locator('[data-slot="tooltip-content"]')).toBeVisible();
  await expect.poll(() => first.locator(".history-title-text").evaluate(node => new DOMMatrix(getComputedStyle(node).transform).m41)).toBeLessThan(-1);
  await page.locator(".chat-header").hover();
  await expect(first.locator(".history-title-text")).toHaveCSS("transform", "none");
  await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(0);
  const short = page.getByRole("button", { name: "Other history", exact: true });
  await short.hover();
  await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(0);
  await expect(short.locator(".history-title-text")).toHaveCSS("animation-name", "none");
  await page.locator(".chat-header").hover();
  await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(0);
  await first.locator(".conversation-open").hover();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(first.locator(".history-title-text")).toHaveCSS("animation-name", "none");
  await page.getByRole("button", { name: "Other history", exact: true }).click();
  await page.evaluate(() => window.historyEvent("a", "run-1", 1, "completed"));
  await expect(first.getByRole("img", { name: "Unread reply" })).toHaveCount(1);
  await page.locator(".chat-header").hover();
  await expect(first.locator(".conversation-open")).toHaveCSS("padding-right", "36px");
  await first.hover();
  await first.getByRole("button", { name: /^Conversation options:/ }).click();
  const outside = await page.locator(".chat-header").boundingBox();
  await page.mouse.move(outside.x + 50, outside.y + 20);
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(first.locator(".conversation-unread")).toHaveCSS("opacity", "0");
  await page.mouse.click(outside.x + 50, outside.y + 20);
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(first.locator(".conversation-unread")).toHaveCSS("opacity", "1");
  await page.screenshot({ path: testInfo.outputPath("history-unread.png") });
  await first.locator(".conversation-open").click();
  await expect(page.locator(".conversation-unread")).toHaveCount(0);
  await page.getByRole("button", { name: "Other history", exact: true }).click();
  await page.evaluate(() => window.historyEvent("a", "run-1", 2, "completed"));
  await expect(page.locator(".conversation-unread")).toHaveCount(0);
  await page.evaluate(() => {
    window.historyEvent("a", "run-2", 1, "generating");
    window.historyEvent("a", "run-2", 2, "failed");
  });
  await expect(page.locator(".conversation-unread")).toHaveCount(0);
  await first.locator(".conversation-open").click();
  await page.evaluate(() => {
    window.historyEvent("a", "run-3", 1, "generating");
    window.historyEvent("a", "run-3", 2, "completed");
  });
  await expect(page.locator(".conversation-unread")).toHaveCount(0);

  const options = first.getByRole("button", { name: /^Conversation options:/ });
  await first.hover();
  const headerBox = await page.locator(".chat-header").boundingBox();
  await options.click();
  await page.mouse.move(headerBox.x + 50, headerBox.y + 20);
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(first.locator(".conversation-actions")).toHaveCSS("opacity", "1");
  await page.mouse.click(headerBox.x + 50, headerBox.y + 20);
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(first.locator(".conversation-actions")).toHaveCSS("opacity", "0");
  await expect(first.locator(".conversation-open")).toHaveCSS("padding-right", "12px");
  await first.locator(".conversation-open").click();
  await page.locator(".chat-header").hover();
  await page.keyboard.press("Tab");
  await expect(options).toBeFocused();
  await expect(first.locator(".conversation-actions")).toHaveCSS("opacity", "1");
  await options.press("Enter");
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(options).toBeFocused();
  await expect(first.locator(".conversation-actions")).toHaveCSS("opacity", "1");

  const navigationStyle = await first.locator(".conversation-title").evaluate(el => {
    const css = getComputedStyle(el);
    return { size: css.fontSize, weight: css.fontWeight, color: css.color, font: css.fontFamily };
  });
  const selectionFill = await first.evaluate(el => getComputedStyle(el).backgroundColor);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settingsSelected = page.locator('.settings-navigation [aria-current="page"]');
  const settingsStyle = await settingsSelected.evaluate(el => {
    const css = getComputedStyle(el);
    return { size: css.fontSize, weight: css.fontWeight, color: css.color, font: css.fontFamily };
  });
  expect(settingsStyle.size).toBe(navigationStyle.size);
  expect(settingsStyle.font).toBe(navigationStyle.font);
  expect(settingsStyle.weight).toBe("500");
  expect(settingsStyle.color).toBe("rgb(24, 24, 27)");
  await expect(settingsSelected).toHaveCSS("background-color", selectionFill);
});
