import { test, expect } from "@playwright/test";
import { mockWorklens, mockExistingConversation } from "./fixture.js";

test("sidebar collapses, preserves its preference and keeps the toggle reachable", async ({ page }) => {
  await mockExistingConversation(page);
  await page.addInitScript(() => {
    window.addEventListener("DOMContentLoaded", () => {
      document.documentElement.dataset.nativeVibrancy = "true";
    });
  });
  await page.goto("/");
  const sidebar = page.locator("#conversation-sidebar");
  const toggle = page.locator(".sidebar-toggle");
  await expect(sidebar).toBeVisible();
  await expect(page.locator(".chat-header")).toHaveCSS("-webkit-app-region", "no-drag");
  await expect(page.locator(".chat-header > div:first-child")).toHaveCSS("-webkit-app-region", "drag");
  await expect(toggle).toHaveCSS("-webkit-app-region", "no-drag");
  await expect(page.locator(".usage-trigger")).toHaveCSS("-webkit-app-region", "no-drag");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(toggle.locator("svg rect")).toHaveAttribute("rx", "5");
  await toggle.click();
  await expect(toggle.locator("svg rect")).toHaveAttribute("rx", "5");
  await expect(sidebar).toHaveAttribute("inert", "");
  await expect(sidebar).toBeHidden();
  await expect(page.locator(".chat-header")).toHaveCSS("-webkit-app-region", "no-drag");
  await page.locator(".usage-trigger").click();
  await expect(page.locator(".usage-popover")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(toggle).toHaveAccessibleName("Expand sidebar");
  const toggleBox = await toggle.boundingBox();
  const titleBox = await page.locator('[data-slot="chat-title"]').boundingBox();
  expect(titleBox.x).toBeGreaterThan(toggleBox.x + toggleBox.width);
  expect(Math.abs(titleBox.y + titleBox.height / 2 - toggleBox.y - toggleBox.height / 2)).toBeLessThanOrEqual(1);
  await page.reload();
  await expect(sidebar).toBeHidden();
  await expect(toggle).toBeVisible();
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(sidebar).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
});

test("sidebar folds while the chat area expands without reflowing its labels", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await mockWorklens(page);
  await page.goto("/");
  const sidebar = page.locator("#conversation-sidebar");
  const width = (await sidebar.boundingBox()).width;
  await page.locator(".sidebar-toggle").click();
  const samples = await page.evaluate(async () => {
    const sidebar = document.querySelector("#conversation-sidebar");
    const main = document.querySelector(".main-content");
    const result = [];
    for (let i = 0; i < 24; i++) {
      await new Promise(requestAnimationFrame);
      result.push({ opacity: Number(getComputedStyle(sidebar.querySelector(".brand")).opacity), width: sidebar.getBoundingClientRect().width, x: main.getBoundingClientRect().x });
    }
    return result;
  });
  expect(samples.some(s => s.x > 0 && s.x < width)).toBe(true);
  expect(samples.every(s => s.width === width)).toBe(true);
  expect(samples.some(s => s.opacity > 0 && s.opacity < 1)).toBe(true);
  await expect(sidebar).toBeHidden();
  expect((await page.locator(".main-content").boundingBox()).x).toBe(0);
});

for (const width of [1280, 850]) {
  test(`native settings reserves window controls after sidebar transitions: ${width}`, async ({ page }, info) => {
    await mockWorklens(page);
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/");
    await page.evaluate(() => { document.documentElement.dataset.nativeVibrancy = "true"; });
    const toggle = page.locator(".sidebar-toggle");
    await toggle.click();
    await expect(page.locator("#conversation-sidebar")).toBeHidden();
    await toggle.click();
    for (const theme of ["light", "dark"]) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      const back = page.getByRole("button", { name: "Back to app", exact: true });
      const box = await back.boundingBox();
      expect(box.y).toBeGreaterThanOrEqual(60);
      await expect(back).toBeInViewport();
      await expect(page.locator(".settings-navigation")).toHaveCSS("padding-top", "60px");
      for (const section of ["General", "Models", "Providers"]) {
        await page.locator(".settings-navigation").getByRole("button", { name: section, exact: true }).click();
        expect((await back.boundingBox()).y).toBe(box.y);
        await expect(page.locator('[data-slot="settings-page-title"]')).toHaveText(section);
      }
      await page.screenshot({ path: info.outputPath(`settings-native-${theme}-${width}.png`) });
      await back.click();
      await expect(page.locator("#conversation-sidebar")).toBeVisible();
      await expect(page.locator(".brand")).toHaveCSS("opacity", "1");
    }
  });
}
