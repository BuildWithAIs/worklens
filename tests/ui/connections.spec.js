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
      await expect(nav.locator("nav button")).toHaveText(language === "en"
        ? ["General", "Connectors", "Providers", "Models", "Skills"]
        : ["通用", "连接器", "供应商", "模型", "技能"]);
      const content = page.locator('[data-section="connections"]');
      await expect(content.locator('[data-mcp-settings]')).not.toBeVisible();
      const activeTab = content.getByRole("tab", { name: language === "en" ? "Built-in" : "内置连接", exact: true });
      await activeTab.hover();
      await expect(activeTab).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(content.getByRole("tablist")).toHaveCSS("border-bottom-width", "0px");
      await expect(nav.getByRole('button', { name: 'MCP', exact: true })).toHaveCount(0);
      await expect(content.getByRole("listitem")).toHaveCount(5);
      const search = content.getByRole("textbox", { name: language === "en" ? "Search connectors" : "搜索连接器" });
      await search.fill("  GITHUB  ");
      await expect(content.getByRole("listitem")).toHaveCount(1);
      await expect(content.getByText("GitHub", { exact: true })).toBeVisible();
      await search.fill("Atlassian");
      await expect(content.getByRole("listitem")).toHaveCount(2);
      await search.fill("搜索");
      await expect(content.getByRole("listitem")).toHaveCount(1);
      await expect(content.getByText("Tavily", { exact: true })).toBeVisible();
      await search.fill("no match");
      await expect(content.locator(".settings-empty")).toBeVisible();
      await content.getByRole("button", { name: language === "en" ? "Clear search" : "清除搜索" }).click();
      await expect(search).toBeFocused();
      const filter = content.getByRole("combobox");
      await filter.selectOption("connected");
      await expect(content.getByRole("listitem")).toHaveCount(0);
      await expect(content.locator(".settings-empty")).toBeVisible();
      await filter.selectOption("available");
      await expect(content.getByRole("listitem")).toHaveCount(5);
      await expect(content.getByRole("heading", { name: language === "en" ? "Available" : "可连接", exact: true })).toBeVisible();
      await filter.selectOption("all");

      await page.keyboard.press("Tab");
      const before = await page.evaluate(() => window.calls.length);
      for (const name of ["Jira", "GitHub", "Tavily"]) {
        const button = content.getByRole("button", { name: `${language === "en" ? "Connect" : "连接"} ${name}`, exact: true });
        await expect(button).toBeEnabled();
      }
      await expect(content.getByRole("button", { name: `${language === "en" ? "Connect" : "连接"} Confluence`, exact: true })).toBeEnabled();
      expect(await page.evaluate(() => window.calls.length)).toBe(before);
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await nav.locator("button").evaluateAll(buttons => buttons.every(button => button.scrollWidth <= button.clientWidth))).toBe(true);
        await expect(content.getByText("GitHub", { exact: true })).toBeVisible();
        expect(await content.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
        await page.screenshot({ path: info.outputPath(`connections-${width}.png`) });
        await content.getByRole("tab", { name: "MCP", exact: true }).click();
        const mcp = page.locator('[data-mcp-settings]');
        await expect(mcp).toBeVisible();
        await expect(mcp.getByRole("textbox", { name: language === "en" ? "Search connections" : "搜索连接", exact: true })).toHaveAttribute("placeholder", language === "en" ? "Search connections…" : "搜索连接…");
        await expect(content.getByRole("tab", { name: "MCP", exact: true })).toHaveAttribute("aria-selected", "true");
        await expect(mcp.getByRole("button", { name: language === "en" ? "Add connection" : "添加连接", exact: true })).toBeVisible();
        await expect(mcp.getByRole("switch", { name: "Code Mode", exact: true })).toHaveCount(0);
        await expect(mcp.getByRole("heading", { name: language === "en" ? "Settings" : "设置", exact: true })).toHaveCount(0);
        await expect(mcp.getByRole("button", { name: language === "en" ? "Edit JSON" : "编辑 JSON", exact: true })).toHaveCount(0);
        expect(await mcp.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
        await page.screenshot({ path: info.outputPath(`mcp-${width}.png`) });
        await content.getByRole("tab", { name: language === "en" ? "Built-in" : "内置连接", exact: true }).click();
      }
      await nav.getByRole("button", { name: language === "en" ? "General" : "通用", exact: true }).click();
      const general = page.locator('[data-section="general"]');
      await expect(general).toBeVisible();
      await expect(general.locator(":scope > section > h2")).toHaveText(language === "en"
        ? ["Preferences", "Tool execution", "Local data"]
        : ["偏好", "工具执行", "本地数据"]);
      await expect(general.getByRole("switch", { name: "Code Mode", exact: true })).toBeChecked();
      await expect(general.getByRole("heading", { name: language === "en" ? "Tool execution" : "工具执行", exact: true })).toBeVisible();
      const codeMode = general.getByRole("switch", { name: "Code Mode", exact: true });
      const hint = general.getByRole("button", { name: language === "en" ? "About Code Mode" : "关于 Code Mode", exact: true });
      const description = language === "en"
        ? "Let the agent use code to combine built-in and MCP tool calls and process results. MCP is optional. Changes apply on each chat’s next message."
        : "允许助手通过代码组合调用内置工具和 MCP 工具，并处理结果。无需配置 MCP 即可使用。更改在各会话的下一条消息中生效。";
      await expect(codeMode).toHaveAccessibleDescription(description);
      await expect(hint).toHaveAccessibleDescription(description);
      await expect(codeMode.locator('xpath=ancestor::*[@data-slot="item"]').locator('[data-slot="item-description"]')).toHaveCount(0);
      const callsBeforeHint = await page.evaluate(() => window.calls.length);
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await hint.hover();
        const tooltip = page.locator('[data-slot="tooltip-content"][data-open]').filter({ hasText: description });
        await expect(tooltip).toBeVisible();
        await expect(tooltip).toHaveText(description);
        const box = await tooltip.boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        await page.screenshot({ path: info.outputPath(`code-mode-hint-${width}.png`) });
        await page.keyboard.press("Escape");
        await expect(tooltip).not.toBeVisible();
        await page.mouse.move(0, 0);
        await codeMode.focus();
        await page.keyboard.press("Shift+Tab");
        await expect(hint).toBeFocused();
        await expect(tooltip).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(tooltip).not.toBeVisible();
        await expect(general).toBeVisible();
        await expect(codeMode).toBeChecked();
      }
      expect(await page.evaluate(() => window.calls.length)).toBe(callsBeforeHint);
      expect(await general.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath("general-390.png") });
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        for (const [id, label] of [["general", language === "en" ? "General" : "通用"], ["providers", language === "en" ? "Providers" : "供应商"]]) {
          await nav.getByRole("button", { name: label, exact: true }).click();
          const section = page.locator(`[data-section="${id}"]`);
          expect(await section.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
          const title = await page.locator(".settings-page-heading h1").boundingBox();
          const first = await section.locator(":scope > *").first().boundingBox();
          expect(first.y - title.y - title.height).toBeGreaterThanOrEqual(24);
          expect(first.y - title.y - title.height).toBeLessThanOrEqual(48);
          await page.screenshot({ path: info.outputPath(`${id}-${width}.png`) });
        }
      }
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
