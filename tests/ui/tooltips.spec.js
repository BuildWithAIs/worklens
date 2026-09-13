import { test, expect } from "@playwright/test";
import { mockWorklens, mockExistingConversation } from "./fixture.js";

test("sidebar and usage share custom hints without native titles", async ({ page }) => {
  await mockExistingConversation(page);
  await page.goto("/");
  const hint = page.locator('[data-slot="tooltip-content"]');
  const toggle = page.locator(".sidebar-toggle");
  await toggle.hover();
  await expect(hint).toHaveText("Collapse sidebar");
  await expect(toggle).not.toHaveAttribute("title");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await page.mouse.move(0, 0);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(toggle).toBeFocused();
  await expect(hint).toHaveCount(1);
  await expect(hint).toHaveText("Expand sidebar");
  await page.keyboard.press("Escape");
  await expect(hint).toBeHidden();
  const usage = page.locator(".usage-trigger");
  await usage.hover();
  await expect(hint).toContainText("Context usage");
  await expect(usage).not.toHaveAttribute("title");
  await usage.click();
  await expect(page.locator(".usage-popover")).toBeVisible();
  await expect(page.locator(".usage-popover [title]")).toHaveCount(0);
  await page.locator(".usage-model").hover();
  await expect(hint).toBeVisible();
  await page.keyboard.press("Escape");
});

test("header details return for history and disappear on new chat", async ({ page }) => {
  await mockExistingConversation(page);
  await page.goto("/");
  await expect(page.locator('[data-slot="chat-title"]')).toHaveText("Existing conversation");
  await expect(page.locator(".usage-trigger")).toBeVisible();
  await page.getByRole("button", { name: /New chat/ }).click();
  await expect(page.locator('[data-slot="chat-title"]')).toHaveCount(0);
  await expect(page.locator(".usage-trigger")).toHaveCount(0);
  await page.getByRole("button", { name: "Existing conversation", exact: true }).click();
  await expect(page.locator(".usage-trigger")).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "About", exact: true })).toHaveCount(0);
});
