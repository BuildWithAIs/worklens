import { test, expect } from "@playwright/test";
import { mockWorklens } from "./fixture.js";

for (const theme of ["light", "dark"]) {
  for (const language of ["en", "zh"]) {
    test(`connections presentation: ${theme}, ${language}`, async ({ page }, info) => {
      await mockWorklens(page);
      await page.addInitScript(({ theme, language }) => {
        localStorage.setItem("worklens.language", language);
        const invoke = window.worklens.invoke;
        window.worklens.invoke = async (name, input) => {
          const value = await invoke(name, input);
          if (name === "bootstrap") value.settings.theme = theme;
          return value;
        };
      }, { theme, language });
      await page.goto("/");
      await page.getByRole("button", { name: language === "en" ? "Settings" : "设置", exact: true }).click();
      const nav = page.locator(".settings-navigation");
      await nav.getByRole("button", { name: language === "en" ? "Connectors" : "连接器", exact: true }).click();
      const content = page.locator('[data-section="connections"]');
      await expect(content.getByRole("listitem")).toHaveCount(3);
      const search = content.getByRole("textbox", { name: language === "en" ? "Search connectors" : "搜索连接器" });
      await search.fill("  GITHUB  ");
      await expect(content.getByRole("listitem")).toHaveCount(1);
      await expect(content.getByText("GitHub", { exact: true })).toBeVisible();
      await search.fill("Atlassian");
      await expect(content.getByRole("listitem")).toHaveCount(2);
      await search.fill("no match");
      await expect(content.locator(".settings-empty")).toBeVisible();
      await content.getByRole("button", { name: language === "en" ? "Clear search" : "清除搜索" }).click();
      await expect(search).toBeFocused();
      const filter = content.getByRole("combobox");
      await filter.selectOption("connected");
      await expect(content.getByRole("listitem")).toHaveCount(0);
      await expect(content.locator(".settings-empty")).toBeVisible();
      await filter.selectOption("available");
      await expect(content.getByRole("listitem")).toHaveCount(3);
      await expect(content.getByRole("heading", { name: language === "en" ? "Available" : "可连接", exact: true })).toBeVisible();
      await filter.selectOption("all");

      await page.keyboard.press("Tab");
      const before = await page.evaluate(() => window.calls.length);
      for (const name of ["Jira", "GitHub"]) {
        const button = content.getByRole("button", { name: `${language === "en" ? "Connect" : "连接"} ${name}`, exact: true });
        await expect(button).toBeEnabled();
      }
      await expect(content.getByRole("button", { name: `${language === "en" ? "Connect" : "连接"} Confluence`, exact: true })).toBeEnabled();
      expect(await page.evaluate(() => window.calls.length)).toBe(before);
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await expect(content.getByText("GitHub", { exact: true })).toBeVisible();
        expect(await content.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
        await page.screenshot({ path: info.outputPath(`connections-${width}.png`) });
      }
      await nav.getByRole("button", { name: language === "en" ? "General" : "通用", exact: true }).click();
      await expect(page.locator('[data-section="general"]')).toBeVisible();
    });
  }
}

test("connection rows match available provider rows", async ({ page }) => {
  await mockWorklens(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const nav = page.locator(".settings-navigation");
  const rowStyle = row => row.evaluate(el => {
    const style = getComputedStyle(el);
    const title = getComputedStyle(el.querySelector(".settings-entry-title"));
    return { height: el.getBoundingClientRect().height, padding: style.padding, gap: title.gap, font: title.font, icon: el.querySelector('[data-slot="provider-icon"]').getBoundingClientRect().width };
  });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await nav.getByRole("button", { name: "Providers", exact: true }).click();
    const provider = page.locator(".settings-provider-list .settings-entry").filter({ hasText: "Anthropic" });
    const expected = await rowStyle(provider);
    await nav.getByRole("button", { name: "Connectors", exact: true }).click();
    expect(await rowStyle(page.locator('[data-connection="jira"]'))).toEqual(expected);
  }
});
