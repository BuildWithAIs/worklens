import { test, expect } from "@playwright/test";
import { mockWorklens } from "../fixture.js";

for (const language of ["en", "zh"]) {
  for (const theme of ["light", "dark"]) {
    test(`Confluence connection lifecycle: ${language}, ${theme}`, async ({
      page,
    }, info) => {
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
      const connect = content.getByRole("button", {
        name: t("Connect Confluence", "连接 Confluence"),
        exact: true,
      });
      await connect.click();
      const dialog = page.getByRole("dialog", {
        name: "Confluence",
        exact: true,
      });
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByRole("button", {
          name: t("Test connection", "测试连接"),
          exact: true,
        }),
      ).toBeDisabled();
      await expect(
        dialog.getByRole("button", { name: t("Save", "保存"), exact: true }),
      ).toBeDisabled();
      await dialog
        .locator("#confluence-url")
        .fill("https://wiki.example.test/wiki");
      await dialog.locator("#confluence-deployment").selectOption("cloud");
      await dialog.locator("#confluence-email").fill("fixture@example.test");
      await dialog.locator("#confluence-token-type").selectOption("scoped");
      await dialog.locator("#confluence-cloud-id").fill("cloud-fixture");
      await dialog.locator("#confluence-token").fill("synthetic-ui-token");
      await expect(dialog.locator("#confluence-access")).toHaveCount(0);
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        expect(
          await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth),
        ).toBe(true);
        await dialog
          .getByRole("button", { name: t("Save", "保存"), exact: true })
          .scrollIntoViewIfNeeded();
        await page.screenshot({
          path: info.outputPath(`confluence-dialog-${width}.png`),
        });
      }
      await dialog
        .getByRole("button", {
          name: t("Test connection", "测试连接"),
          exact: true,
        })
        .click();
      await expect(
        page.locator('[data-slot="toast-title"]').filter({
          hasText: t("Connected to Confluence", "已连接 Confluence"),
        }),
      ).toBeVisible();
      await dialog
        .getByRole("button", { name: t("Save", "保存"), exact: true })
        .click();
      await expect(dialog).not.toBeVisible();
      await expect(
        content.getByRole("heading", {
          name: t("Connected", "已连接"),
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        content.getByText("https://wiki.example.test/wiki", { exact: true }),
      ).toBeVisible();
      const filter = content.getByRole("combobox", {
        name: t("Filter connectors", "筛选连接器"),
      });
      await filter.selectOption("connected");
      await expect(content.getByRole("listitem")).toHaveCount(1);
      await filter.selectOption("available");
      await expect(content.getByRole("listitem")).toHaveCount(2);
      await filter.selectOption("all");
      const manage = content.getByRole("button", {
        name: t("Manage Confluence", "管理 Confluence"),
        exact: true,
      });
      await manage.click();
      await expect(dialog.locator("#confluence-token")).toHaveValue("");
      await expect(dialog.locator("#confluence-access")).toHaveCount(0);
      await dialog.locator("#confluence-token").fill("unsaved-secret");
      await page.keyboard.press("Escape");
      await expect(manage).toBeFocused();
      await manage.click();
      await expect(dialog.locator("#confluence-token")).toHaveValue("");
      await dialog
        .getByRole("button", { name: t("Disconnect", "断开连接"), exact: true })
        .click();
      const confirmation = page.getByRole("dialog", {
        name: t("Disconnect Confluence?", "断开 Confluence 的连接？"),
        exact: true,
      });
      await expect(confirmation).toBeVisible();
      await expect(
        confirmation.getByRole("button", {
          name: t("Cancel", "取消"),
          exact: true,
        }),
      ).toBeFocused();
      expect(
        await page.evaluate(
          () =>
            window.calls.filter((c) => c.name === "confluenceRemove").length,
        ),
      ).toBe(0);
      await confirmation
        .getByRole("button", { name: t("Cancel", "取消"), exact: true })
        .click();
      await expect(
        dialog.getByRole("button", {
          name: t("Disconnect", "断开连接"),
          exact: true,
        }),
      ).toBeFocused();
      await dialog
        .getByRole("button", { name: t("Disconnect", "断开连接"), exact: true })
        .click();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeVisible();
      expect(
        await page.evaluate(
          () =>
            window.calls.filter((c) => c.name === "confluenceRemove").length,
        ),
      ).toBe(0);
      await dialog
        .getByRole("button", { name: t("Disconnect", "断开连接"), exact: true })
        .click();
      await page.screenshot({
        path: info.outputPath("disconnect-confirmation.png"),
      });
      await confirmation
        .getByRole("button", { name: t("Disconnect", "断开连接"), exact: true })
        .click();

      await expect(dialog).not.toBeVisible();
      await expect(connect).toBeVisible();
      const calls = await page.evaluate(() =>
        window.calls.filter((call) => call.name === "confluenceSave"),
      );
      expect(calls).toHaveLength(1);
      expect(calls[0].input).not.toHaveProperty("access");
      expect(calls[0].input).toMatchObject({
        deployment: "cloud",
        email: "fixture@example.test",
        tokenType: "scoped",
        cloudId: "cloud-fixture",
        token: "synthetic-ui-token",
      });
    });
  }
}
