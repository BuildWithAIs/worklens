import { test, expect } from "@playwright/test";
import { mockWorklens } from "../fixture.js";

for (const language of ["en", "zh"])
  for (const [service, name] of [
    ["github", "GitHub"],
    ["jira", "Jira"],
    ["confluence", "Confluence"],
    ["jev", "Jev"],
  ])
    test(`${name} rate limit feedback uses ${language}`, async ({ page }) => {
      await mockWorklens(page);
      await page.addInitScript(
        ({ language, service, name }) => {
          localStorage.setItem("worklens.language", language);
          const invoke = window.worklens.invoke;
          window.worklens.invoke = (async (method, input) => {
            if (method === `${service}Test`)
              throw new Error(
                name === "Jev"
                  ? "Jev is busy. Try again later."
                  : `${name} 要求稍后重试`,
              );
            return invoke(method, input);
          }) as typeof window.worklens.invoke;
        },
        { language, service, name },
      );
      const t = (en: string, zh: string) => (language === "en" ? en : zh);
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
      await expect(page.locator('[data-slot="toast-title"]')).toHaveText(
        t(`Couldn’t connect to ${name}`, `无法连接 ${name}`),
      );
      await expect(page.locator('[data-slot="toast-description"]')).toHaveText(
        name === "Jev"
          ? t("Jev is busy. Try again later.", "Jev 暂时繁忙，请稍后重试。")
          : t(
              "Too many requests. Try again later.",
              "请求过于频繁，请稍后重试。",
            ),
      );
    });
