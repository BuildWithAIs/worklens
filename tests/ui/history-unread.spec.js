import { test, expect } from "@playwright/test";
import { mockWorklens } from "./fixture.js";

test("history fades long titles and marks only unseen completed replies", async ({ page }, testInfo) => {
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
  await expect(first.locator(".conversation-open")).toHaveCSS("padding-right", "10px");
  await expect(title).toHaveAttribute("data-overflow", "true");
  await expect(title).toHaveCSS("text-overflow", "clip");
  expect(await title.evaluate(el => getComputedStyle(el).maskImage)).toContain("linear-gradient");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await first.locator(".conversation-open").hover();
  await expect(first.locator(".conversation-open")).toHaveCSS("padding-right", "36px");
  await expect(first.locator(".history-title-text")).toHaveCSS("animation-name", "history-title-pan");
  await expect(page.locator('[data-slot="tooltip-content"]')).toBeVisible();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(first.locator(".history-title-text")).toHaveCSS("animation-name", "none");
  await page.getByRole("button", { name: "Other history", exact: true }).click();
  await page.evaluate(() => window.historyEvent("a", "run-1", 1, "completed"));
  await expect(first.getByRole("img", { name: "Unread reply" })).toHaveCount(1);
  await page.locator(".chat-header").hover();
  await expect(first.locator(".conversation-open")).toHaveCSS("padding-right", "28px");
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
  await expect(first.locator(".conversation-open")).toHaveCSS("padding-right", "10px");
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
  expect(settingsStyle).toEqual(navigationStyle);
  await expect(settingsSelected).toHaveCSS("background-color", selectionFill);
});
