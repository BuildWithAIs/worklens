import { test, expect } from "@playwright/test";
import { mockWorklens } from "../fixture.js";
for (const language of ["en", "zh"]) {
  for (const [service, name] of [
    ["jira", "Jira"],
    ["confluence", "Confluence"],
    ["github", "GitHub"],
  ]) {
    test(`${name}: runtime error uses only one localized toast in ${language}`, async ({
      page,
    }, info) => {
      await mockWorklens(page);
      await page.addInitScript(
        ({ service, name, language }) => {
          localStorage.setItem("worklens.language", language);
          const invoke = window.worklens.invoke;
          window.testRequests = 0;
          window.worklens.invoke = async (method, input) => {
            if (method === `${service}Test`) {
              window.testRequests++;
              if (!window.connectionRecovered)
                throw new Error(`${name} 网络请求失败或超时`);
              return "已连接：张三 · https://example.test";
            }
            return invoke(method, input);
          };
        },
        { service, name, language },
      );
      const t = (en, zh) => (language === "en" ? en : zh);
      await page.goto("/");
      await page
        .getByRole("button", { name: t("Settings", "设置"), exact: true })
        .click();
      await page
        .locator(".settings-navigation")
        .getByRole("button", { name: t("Connectors", "连接器"), exact: true })
        .click();
      await page
        .getByRole("button", {
          name: `${t("Connect", "连接")} ${name}`,
          exact: true,
        })
        .click();
      const dialog = page.getByRole("dialog", { name, exact: true });
      await dialog.locator(`#${service}-url`).fill("https://example.test");
      await dialog.locator(`#${service}-token`).fill("synthetic-token");
      await dialog
        .getByRole("button", {
          name: t("Test connection", "测试连接"),
          exact: true,
        })
        .click();
      const message = t(`Couldn’t connect to ${name}`, `无法连接 ${name}`);
      await expect(dialog.getByRole("alert")).toHaveCount(0);
      await expect(
        page.locator('[data-slot="toast-title"]').filter({ hasText: message }),
      ).toBeVisible();
      expect(await page.evaluate(() => window.testRequests)).toBe(1);
      await page.screenshot({ path: info.outputPath("localized-error.png") });
      await page.evaluate(() => {
        window.connectionRecovered = true;
      });
      await dialog
        .getByRole("button", {
          name: t("Test connection", "测试连接"),
          exact: true,
        })
        .click();
      await expect(
        page
          .locator('[data-slot="toast-description"]')
          .filter({ hasText: "张三" }),
      ).toBeVisible();
      await expect(dialog.getByRole("alert")).toHaveCount(0);
    });
  }
}
