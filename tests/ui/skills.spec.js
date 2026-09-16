import { test, expect } from "@playwright/test";
import { mockWorklens } from "./fixture.js";

for (const theme of ["light", "dark"]) {
  for (const language of ["en", "zh"]) {
    test(`skills presentation: ${theme}, ${language}`, async ({ page }, info) => {
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
      const t = (en, zh) => (language === "en" ? en : zh);
      await page.goto("/");
      await page.getByRole("button", { name: t("Settings", "设置"), exact: true }).click();
      const nav = page.locator(".settings-navigation");
      await nav.getByRole("button", { name: t("Skills", "技能"), exact: true }).click();
      const content = page.locator('[data-section="skills"]');
      await expect(content.getByRole("heading", { name: t("Built-in", "内置") })).toBeVisible();
      await expect(content.getByRole("heading", { name: t("Local (~/.agents/skills)", "本地 (~/.agents/skills)") })).toBeVisible();
      await expect(content.getByRole("listitem")).toHaveCount(4);
      // Rows show the one-sentence summary, clipped to a single line.
      const row = content.getByRole("listitem").filter({ hasText: "code-documentation" });
      const description = row.locator(".settings-entry-description");
      await expect(description).toHaveText(/^Use this skill when the user requests/);
      expect(await description.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe("nowrap");
      // Every row exposes its SKILL.md and a labelled toggle.
      await expect(content.getByRole("button", { name: t("Show SKILL.md for code-documentation", "显示 code-documentation 的 SKILL.md") })).toBeVisible();
      const toggle = content.getByRole("switch", { name: t("Enable deep-research", "启用 deep-research") });
      await expect(toggle).not.toBeChecked();
      await toggle.hover();
      await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText(t("Enable", "启用"));
      await toggle.click();
      await expect(toggle).toBeChecked();
      await expect(page.locator('[data-slot="toast-title"]').filter({ hasText: t("deep-research enabled", "已启用 deep-research") })).toBeVisible();
      const reveal = content.getByRole("button", { name: t("Show SKILL.md for brave-search", "显示 brave-search 的 SKILL.md") });
      await reveal.click();
      expect(await page.evaluate(() => window.calls.filter((c) => c.name === "skillsReveal").map((c) => c.input))).toEqual([{ name: "brave-search" }]);
      const filter = content.getByRole("combobox");
      await filter.selectOption("local");
      await expect(content.getByRole("listitem")).toHaveCount(2);
      await filter.selectOption("all");
      await content.getByRole("textbox", { name: t("Search skills", "搜索技能") }).fill("pdf");
      await expect(content.getByRole("listitem")).toHaveCount(1);
      await expect(content.getByRole("heading", { name: t("Built-in", "内置") })).toHaveCount(0);
      await content.getByRole("button", { name: t("Clear search", "清除搜索") }).click();
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await content.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        await page.screenshot({ path: info.outputPath(`skills-${width}.png`) });
      }
    });
  }
}
