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
      await expect(content.getByRole("listitem")).toHaveCount(3);
      // Rows show the one-sentence summary, clipped to a single line.
      const row = content.getByRole("listitem").filter({ hasText: "tavily-research" });
      const description = row.locator(".settings-entry-description");
      const source = await page.evaluate(async () => (await window.worklens.invoke("skillsList", undefined)).builtin[0]);
      await expect(description).toHaveText(source.summary);
      await row.getByRole("button", { name: t("About tavily-research", "了解tavily-research"), exact: true }).click();
      const details = page.getByRole("dialog", { name: "tavily-research", exact: true });
      await expect(details.locator('[data-slot="dialog-description"]')).toHaveText(source.description);
      await expect(details).toContainText(t("Changes apply on the next conversation turn.", "更改将在下一轮对话生效。"));
      await page.keyboard.press("Escape");
      await content.getByRole("button", { name: t("About Built-in", "关于内置"), exact: true }).hover();
      await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText(t("Ships with WorkLens.", "随 WorkLens 安装。"));
      expect(await description.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe("nowrap");
      // Every row exposes its SKILL.md and a labelled toggle.
      await expect(content.getByRole("button", { name: t("Show SKILL.md for tavily-research", "显示 tavily-research 的 SKILL.md") })).toBeVisible();
      const toggle = content.getByRole("switch", { name: t("Enable tavily-research", "启用 tavily-research") });
      await expect(toggle).not.toBeChecked();
      await toggle.hover();
      await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText(t("Enable", "启用"));
      await toggle.click();
      await expect(toggle).toBeChecked();
      await expect(page.locator('[data-slot="toast-title"]').filter({ hasText: t("tavily-research enabled", "已启用 tavily-research") })).toBeVisible();
      const reveal = content.getByRole("button", { name: t("Show SKILL.md for brave-search", "显示 brave-search 的 SKILL.md") });
      await reveal.click();
      expect(await page.evaluate(() => window.calls.filter((c) => c.name === "skillsReveal").map((c) => c.input))).toEqual([{ id: "2".padStart(64, "0") }]);
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

test("skills loading, persistent failure, and retry never masquerade as empty", async ({ page }) => {
  await mockWorklens(page);
  await page.addInitScript(() => {
    const invoke = window.worklens.invoke;
    window.failSkills = true;
    window.worklens.invoke = async (name, input) => {
      if (name === "skillsList") await new Promise((resolve) => { window.releaseSkillLoad = resolve; });
      if ((name === "skillsList" || name === "skillsRefresh") && window.failSkills) throw new Error("Read failed");
      return invoke(name, input);
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator(".settings-navigation").getByRole("button", { name: "Skills", exact: true }).click();
  const content = page.locator('[data-section="skills"]');
  await expect(content.getByRole("status")).toHaveText("Loading skills…");
  await expect(content.getByText("No built-in skills yet.")).toHaveCount(0);
  await page.evaluate(() => window.releaseSkillLoad());
  await expect(content.getByRole("alert")).toContainText("Read failed");
  await expect(content.getByText("No built-in skills yet.")).toHaveCount(0);
  await page.evaluate(() => { window.failSkills = false; });
  await content.getByRole("button", {name: "Try again", exact: true}).click();
  await expect(content.getByRole("alert")).toHaveCount(0);
  await expect(content.getByRole("listitem")).toHaveCount(3);
});

test("duplicate skills explain precedence, reveal their own file, and expose full descriptions by keyboard", async ({ page }) => {
  await mockWorklens(page);
  await page.addInitScript(() => {
    const invoke = window.worklens.invoke;
    window.worklens.invoke = async (name, input) => {
      const result = await invoke(name, input);
      if (name === "skillsList" || name === "skillsRefresh") result.local.push({
        id: "f".repeat(64), name: "tavily-research", source: "local", enabled: false, shadowedBy: "builtin",
        summary: "Local research.", description: "Local research. " + "Full local description. ".repeat(30), path: "/local/tavily-research/SKILL.md",
      });
      return result;
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator(".settings-navigation").getByRole("button", { name: "Skills", exact: true }).click();
  const content = page.locator('[data-section="skills"]');
  const local = content.getByRole("listitem").filter({hasText: "Inactive:"});
  await expect(local.getByRole("switch")).toBeDisabled();
  await expect(local).toContainText("Built-in version takes precedence");
  await local.getByRole("button", {name: "Show SKILL.md for tavily-research", exact: true}).click();
  expect(await page.evaluate(() => window.calls.filter((call) => call.name === "skillsReveal").at(-1).input)).toEqual({id: "f".repeat(64)});
  const details = local.getByRole("button", {name: "About tavily-research", exact: true});
  await details.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", {name: "tavily-research", exact: true});
  await expect(dialog).toContainText("Full local description.");
  await expect(dialog).toContainText("Changes apply on the next conversation turn");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
});
