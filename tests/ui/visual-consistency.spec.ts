import type { Bootstrap } from "../../src/shared/contracts";
import { test, expect } from "@playwright/test";
import { mockWorklens } from "./fixture.js";

for (const theme of ["light", "dark"]) {
  for (const width of [1280, 390]) {
    test(`shared styles: ${theme}, ${width}px`, async ({ page }, testInfo) => {
      await mockWorklens(page);
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      const composer = page.locator(".aui-composer-input");
      await expect(composer).toHaveCSS("font-size", "14px");
      const chatScroll = await page.locator('[data-slot="aui_thread-viewport"]').evaluate(el => ({
        width: getComputedStyle(el, "::-webkit-scrollbar").width,
        color: getComputedStyle(el, "::-webkit-scrollbar-thumb").backgroundColor,
        radius: getComputedStyle(el, "::-webkit-scrollbar-thumb").borderRadius,
      }));
      await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Providers", exact: true }).click();
      const search = page.getByRole("textbox", { name: "Search providers" });
      await expect(search).toHaveCSS("font-size", "14px");
      await expect(page.getByRole("combobox", { name: "Filter providers" })).toHaveCSS("font-size", "14px");
      await expect(page.locator('[data-slot="settings-page-title"]')).toHaveCSS("font-size", "26px");
      await page.mouse.move(0, 0);
      const settingsScroll = await page.locator(".settings-scroll").evaluate(el => ({
        width: getComputedStyle(el, "::-webkit-scrollbar").width,
        color: getComputedStyle(el, "::-webkit-scrollbar-thumb").backgroundColor,
        radius: getComputedStyle(el, "::-webkit-scrollbar-thumb").borderRadius,
      }));
      expect(settingsScroll).toEqual(chatScroll);
      expect(settingsScroll.width).toBe("10px");
      const selected = page.locator('.settings-navigation [aria-current="page"]');
      const before = await selected.evaluate(el => getComputedStyle(el).backgroundColor);
      await selected.hover();
      await expect(selected).toHaveCSS("background-color", before);
      await search.click();
      await search.press("Tab");
      const filter = page.getByRole("combobox", { name: "Filter providers" });
      await expect(filter).toBeFocused();
      expect(await filter.evaluate(el => getComputedStyle(el).boxShadow)).toContain("1px");
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      await expect(page.getByRole("button", { name: "Back to app", exact: true })).toBeInViewport();
      await expect(page.getByRole("button", { name: "General", exact: true })).toBeInViewport();
      await expect(page.getByRole("button", { name: "Models", exact: true })).toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath(`settings-${theme}-${width}.png`) });
      await page.keyboard.press("Escape");
      await expect(composer).toBeVisible();
    });
  }
}

test("reduced transparency and motion cover both navigation surfaces", async ({ page }) => {
  await mockWorklens(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setEmulatedMedia", { features: [
    { name: "prefers-reduced-transparency", value: "reduce" },
    { name: "prefers-reduced-motion", value: "reduce" },
  ] });
  await page.goto("/");
  await expect(page.locator(".sidebar")).toBeVisible();
  await page.evaluate(() => document.documentElement.dataset.nativeVibrancy = "true");
  await expect(page.locator(".sidebar")).toHaveCSS("background-color", "rgb(250, 250, 250)");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Providers", exact: true }).click();
  await expect(page.locator(".settings-navigation")).toHaveCSS("background-color", "rgb(250, 250, 250)");
  await expect(page.locator(".settings-navigation nav")).toHaveCSS("animation-name", "none");
  await expect(page.locator(".settings-backdrop")).toHaveCSS("backdrop-filter", "none");
});

test("dark native sidebars share a translucent neutral scrim", async ({ page }) => {
  await mockWorklens(page);
  await page.addInitScript(() => {
    const invoke = window.worklens.invoke;
    window.worklens.invoke = async (method, input) => {
      const result = await invoke(method, input);
      if (method === "bootstrap") (result as Bootstrap).settings.theme = "dark";
      return result;
    };
  });
  await page.goto("/");
  await page.evaluate(() => {
    document.documentElement.dataset.nativeVibrancy = "true";
  });
  const sidebar = page.locator(".sidebar");
  const scrim = await sidebar.evaluate(el => getComputedStyle(el).backgroundColor);
  expect(scrim).toBe("rgba(32, 32, 32, 0.6)");
  await expect(page.locator(".main-content")).toHaveCSS("background-color", "rgb(24, 24, 24)");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.locator(".settings-navigation")).toHaveCSS("background-color", scrim);
  await expect(page.locator(".settings-pane")).toHaveCSS("background-color", "rgb(24, 24, 24)");
});

for (const width of [1280, 1000, 850]) {
  test(`chat and settings sidebars align at ${width}px`, async ({ page }) => {
    await mockWorklens(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    const chatWidth = (await page.locator(".sidebar").boundingBox())!.width;
    expect(chatWidth).toBe(width > 1050 ? 280 : 248);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    expect((await page.locator(".settings-navigation").boundingBox())!.width).toBe(chatWidth);
    expect((await page.locator(".settings-pane").boundingBox())!.x).toBe(chatWidth);
  });
}
