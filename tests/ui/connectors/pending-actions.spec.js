import { test, expect } from "@playwright/test";
import { mockWorklens } from "../fixture.js";
for (const [service, name] of [
  ["jira", "Jira"],
  ["confluence", "Confluence"],
  ["github", "GitHub"],
]) {
  for (const language of ["en", "zh"]) {
    test(`${name} ${language}: saving fits and notifies; failed disconnect is retryable`, async ({
      page,
    }, info) => {
      await mockWorklens(page);
      await page.addInitScript(
        ({ service, language }) => {
          localStorage.setItem("worklens.language", language);
          const invoke = window.worklens.invoke;
          window.worklens.invoke = async (method, input) => {
            if (method === `${service}Save` && window.holdSave)
              await new Promise((resolve) => {
                window.finishSave = resolve;
              });
            if (method === `${service}Remove` && window.failRemove)
              throw new Error("Fixture disconnect failed");
            return invoke(method, input);
          };
        },
        { service, language },
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
        .getByRole("button", { name: t("Save", "保存"), exact: true })
        .click();
      await expect(dialog).not.toBeVisible();
      await expect(
        page
          .locator('[data-slot="toast-title"]')
          .filter({ hasText: new RegExp(name) }),
      ).toBeVisible();
      // Wait for the initial toast to leave before verifying a later save.
      await expect(page.locator('[data-slot="toast-title"]')).toHaveCount(0, {
        timeout: 6000,
      });
      await page
        .getByRole("button", {
          name: `${t("Manage", "管理")} ${name}`,
          exact: true,
        })
        .click();
      await page.evaluate(() => {
        window.holdSave = true;
      });
      await dialog
        .getByRole("button", { name: t("Save", "保存"), exact: true })
        .click();
      await expect(
        dialog.getByRole("button", {
          name: t("Saving…", "正在保存…"),
          exact: true,
        }),
      ).toBeDisabled();
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        expect(
          await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth),
        ).toBe(true);
        const footer = dialog.locator('[data-slot="dialog-footer"]').first();
        expect(
          await footer.evaluate((el) => el.scrollWidth <= el.clientWidth),
        ).toBe(true);
        if (width === 1280) {
          const tops = await footer
            .locator("button")
            .evaluateAll((buttons) =>
              buttons.map((button) =>
                Math.round(button.getBoundingClientRect().top),
              ),
            );
          expect(new Set(tops).size).toBe(1);
        }
        await page.screenshot({ path: info.outputPath(`saving-${width}.png`) });
      }
      await page.evaluate(() => window.finishSave());
      await expect(dialog).not.toBeVisible();
      await expect(
        page
          .locator('[data-slot="toast-title"]')
          .filter({ hasText: new RegExp(name) }),
      ).toBeVisible();
      await page
        .getByRole("button", {
          name: `${t("Manage", "管理")} ${name}`,
          exact: true,
        })
        .click();
      await dialog
        .getByRole("button", { name: t("Disconnect", "断开连接"), exact: true })
        .click();
      const confirm = page.getByRole("dialog", {
        name: t(`Disconnect ${name}?`, `断开 ${name} 的连接？`),
        exact: true,
      });
      await page.evaluate(() => {
        window.failRemove = true;
      });
      await confirm
        .getByRole("button", { name: t("Disconnect", "断开连接"), exact: true })
        .click();
      await expect(
        page
          .locator('[data-slot="toast-description"]')
          .filter({ hasText: "Fixture disconnect failed" }),
      ).toBeVisible();
      await expect(confirm).toBeVisible();
      await expect(
        confirm.getByRole("button", {
          name: t("Disconnect", "断开连接"),
          exact: true,
        }),
      ).toBeEnabled();
      await confirm
        .getByRole("button", { name: t("Cancel", "取消"), exact: true })
        .click();
      await expect(dialog).toBeVisible();
    });
  }
}
