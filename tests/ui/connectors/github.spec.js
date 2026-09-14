import { test, expect } from "@playwright/test";
import { mockWorklens } from "../fixture.js";
for (const language of ["en", "zh"])
  for (const theme of ["light", "dark"]) {
    test(`GitHub connection: ${language}, ${theme}`, async ({ page }, info) => {
      await mockWorklens(page);
      await page.addInitScript(
        ({ language, theme }) => {
          localStorage.setItem("worklens.language", language);
          const invoke = window.worklens.invoke;
          window.worklens.invoke = async (method, input) => {
            const result = await invoke(method, input);
            if (method === "bootstrap") result.settings.theme = theme;
            return result;
          };
        },
        { language, theme },
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
      const content = page.locator('[data-section="connections"]');
      await content
        .getByRole("button", {
          name: t("Connect GitHub", "连接 GitHub"),
          exact: true,
        })
        .click();
      const dialog = page.getByRole("dialog", { name: "GitHub", exact: true });
      await expect(dialog.locator("#github-url")).toHaveValue("");
      await dialog
        .getByRole("button", {
          name: t("Test connection", "测试连接"),
          exact: true,
        })
        .click();
      await expect(dialog.getByRole("alert")).toHaveText(
        t("Enter a GitHub URL", "请填写 GitHub 地址"),
      );
      await dialog.locator("#github-url").fill("https://github.example.test");
      await dialog.locator("#github-token").fill("synthetic-ui-token");
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        expect(
          await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth),
        ).toBe(true);
        await page.screenshot({
          path: info.outputPath(`github-dialog-${width}.png`),
        });
      }
      await dialog
        .getByRole("button", {
          name: t("Test connection", "测试连接"),
          exact: true,
        })
        .click();
      await expect(dialog.getByRole("status")).toContainText("fixture-user");
      await dialog
        .getByRole("button", { name: t("Save", "保存"), exact: true })
        .click();
      await expect(dialog).not.toBeVisible();
      const manage = content.getByRole("button", {
        name: t("Manage GitHub", "管理 GitHub"),
        exact: true,
      });
      await expect(manage).toBeVisible();
      await page.screenshot({ path: info.outputPath("github-connected.png") });
      await manage.click();
      await expect(dialog.locator("#github-token")).toHaveValue("");
      await dialog.locator("#github-token").fill("unsaved-secret");
      await page.keyboard.press("Escape");
      await manage.click();
      await expect(dialog.locator("#github-token")).toHaveValue("");
      await dialog
        .getByRole("button", { name: t("Disconnect", "断开连接"), exact: true })
        .click();
      await content
        .getByRole("button", {
          name: t("Connect GitHub", "连接 GitHub"),
          exact: true,
        })
        .click();
      await expect(dialog.locator("#github-url")).toHaveValue("");
      expect(
        await page.evaluate(() =>
          window.calls.filter((c) => c.name === "githubSave"),
        ),
      ).toHaveLength(1);
    });
  }
