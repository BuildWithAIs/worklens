import { test, expect } from "@playwright/test";
import { mockWorklens } from "./fixture.js";

for (const language of ["en", "zh"]) {
  test(`refresh summaries count new model and skill IDs (${language})`, async ({
    page,
  }) => {
    await mockWorklens(page);
    await page.addInitScript((language) => {
      localStorage.setItem("worklens.language", language);
      const invoke = window.worklens.invoke;
      let modelRefreshes = 0;
      let skillRefreshes = 0;
      window.worklens.invoke = async (name, input) => {
        if (name === "refreshModels") modelRefreshes++;
        if (name === "skillsRefresh") skillRefreshes++;
        const result = await invoke(name, input);
        if (name === "bootstrap" && modelRefreshes) {
          const provider = result.providers.find((p) => p.id === "deepseek");
          provider.models.push(
            ...[1, 2].map((i) => ({
              ...provider.models[0],
              id: `new-${i}`,
              name: `New ${i}`,
            })),
          );
          // Existing model renames do not count as new discoveries.
          provider.models[0].name = "Renamed existing model";
        }
        if (["skillsList", "skillsRefresh"].includes(name) && skillRefreshes) {
          result.local.push(
            ...Array.from({ length: skillRefreshes === 1 ? 1 : 3 }, (_, i) => ({
              ...result.local[0],
              id: `new-skill-${i}`,
              name: `new-skill-${i}`,
              enabled: false,
            })),
          );
          result.builtin[0].enabled = true;
          result.builtin[0].summary = "Updated existing description";
        }
        return result;
      };
    }, language);
    const t = (en, zh) => (language === "en" ? en : zh);
    await page.goto("/");
    await page
      .getByRole("button", { name: t("Settings", "设置"), exact: true })
      .click();
    const nav = page.locator(".settings-navigation");
    await nav
      .getByRole("button", { name: t("Models", "模型"), exact: true })
      .click();
    const refreshModels = page.getByRole("button", {
      name: t("Refresh models: DeepSeek", "刷新模型：DeepSeek"),
      exact: true,
    });
    await refreshModels.click();
    await expect(
      page
        .locator('[data-slot="toast-title"]')
        .filter({
          hasText: t("Refreshed · 2 new models", "已刷新，新增 2 个模型"),
        }),
    ).toBeVisible();
    await refreshModels.click();
    await expect(
      page
        .locator('[data-slot="toast-title"]')
        .filter({ hasText: t("Models refreshed", "模型已刷新") }),
    ).toBeVisible();
    await nav
      .getByRole("button", { name: t("Skills", "技能"), exact: true })
      .click();
    const refreshSkills = page.getByRole("button", {
      name: t("Refresh skills", "刷新技能"),
      exact: true,
    });
    await expect(
      page.locator('[data-section="skills"]').getByRole("listitem"),
    ).toHaveCount(3);
    await refreshSkills.click();
    await expect(
      page
        .locator('[data-slot="toast-title"]')
        .filter({
          hasText: t("Refreshed · 1 new skill", "已刷新，新增 1 个技能"),
        }),
    ).toBeVisible();
    await refreshSkills.click();
    await expect(
      page
        .locator('[data-slot="toast-title"]')
        .filter({
          hasText: t("Refreshed · 2 new skills", "已刷新，新增 2 个技能"),
        }),
    ).toBeVisible();
    await refreshSkills.click();
    await expect(
      page
        .locator('[data-slot="toast-title"]')
        .filter({ hasText: t("Skills refreshed", "技能已刷新") }),
    ).toBeVisible();
  });
}
