import { test, expect } from "@playwright/test";
import { mockWorklens } from "./fixture.js";

test("pinned groups share rows, scrollbars and survive refresh; failed saves keep state", async ({ page }) => {
  await mockWorklens(page);
  await page.addInitScript(() => {
    const invoke = window.worklens.invoke;
    let pins = [];
    let rows = Array.from({ length: 40 }, (_, i) => ({ id: `history-${i}`, title: `History ${i}`, updatedAt: "2026-09-13", phase: i === 0 ? "generating" : "completed" }));
    window.failPinSave = false;
    window.worklens.invoke = async (name, input) => {
      if (name === "settings" && input.pinnedConversationIds) {
        if (window.failPinSave) throw new Error("Fixture save failed");
        pins = input.pinnedConversationIds;
      }
      if (name === "delete") rows = rows.filter(row => row.id !== input.id);
      const result = await invoke(name, input);
      if (name === "bootstrap") { result.conversations = rows; result.settings.pinnedConversationIds = pins; }
      if (name === "settings") result.pinnedConversationIds = pins;
      return result;
    };
  });
  await page.goto("/");
  const pinned = page.getByRole("region", { name: "Pinned", exact: true });
  const recents = page.getByRole("region", { name: "Recents", exact: true });
  await expect(pinned).toHaveCount(0);
  const menu = async (name) => {
    await page.getByRole("button", { name: `Conversation options: ${name}`, exact: true }).click();
  };
  await menu("History 0");
  await expect(page.getByRole("menuitem", { name: "Pin", exact: true }).locator("svg")).toBeVisible();
  await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
  await expect(pinned.locator(".conversation-open")).toHaveCount(1);
  await expect(pinned.locator(".history-loading-ring")).toBeVisible();
  await expect(recents.locator(".conversation-open")).toHaveCount(39);
  const font = locator => locator.evaluate(el => {
    const c = getComputedStyle(el); return [c.fontSize, c.fontWeight, c.color, c.fontFamily];
  });
  expect(await font(pinned.locator(".conversation-title"))).toEqual(await font(recents.locator(".conversation-title").first()));
  const list = page.locator(".conversation-list");
  const scrollbar = locator => locator.evaluate(el => {
    return [getComputedStyle(el, "::-webkit-scrollbar").width, getComputedStyle(el, "::-webkit-scrollbar-thumb").backgroundColor];
  });
  await page.mouse.move(0, 0);
  const row = pinned.locator(".conversation-item");
  const ring = row.locator(".history-loading-ring");
  await expect(row.locator(".conversation-open")).toHaveCSS("padding-right", "28px");
  const rowBox = await row.boundingBox();
  const ringBox = await ring.boundingBox();
  expect(rowBox.x + rowBox.width - ringBox.x - ringBox.width).toBeCloseTo(10.5, 1);
  expect(ringBox.y + ringBox.height / 2).toBeCloseTo(rowBox.y + rowBox.height / 2, 0);
  await expect(ring).toHaveCSS("opacity", "1");
  await row.hover();
  await expect(ring).toHaveCSS("opacity", "0");
  await page.mouse.move(0, 0);

  expect(await scrollbar(list)).toEqual(await scrollbar(page.locator('[data-slot="aui_thread-viewport"]')));
  expect(await list.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await list.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect(page.getByRole("button", { name: "History 39", exact: true })).toBeInViewport();
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeInViewport();
  await list.evaluate(el => { el.scrollTop = 0; });
  await page.evaluate(() => { window.failPinSave = true; });
  await menu("History 0");
  await page.getByRole("menuitem", { name: "Unpin", exact: true }).click();
  await expect(page.locator('[data-slot="toast-title"]').filter({ hasText: "Fixture save failed" })).toBeVisible();
  await expect(pinned.locator(".conversation-open")).toHaveCount(1);
  await page.evaluate(() => { window.failPinSave = false; });
  await menu("History 0");
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await page.getByRole("dialog", { name: "Delete conversation?" }).getByRole("button", { name: "Delete", exact: true }).click();
  await expect(pinned).toHaveCount(0);
  await expect(recents.locator(".conversation-open")).toHaveCount(39);
});
