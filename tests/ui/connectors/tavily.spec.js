import { test, expect } from "@playwright/test";
import { mockWorklens } from "../fixture.js";
for (const language of ["en", "zh"])
  for (const theme of ["light", "dark"]) {
    test(`Tavily connection: ${language}, ${theme}`, async ({ page }, info) => {
      await mockWorklens(page);
      await page.addInitScript(
        ({ language, theme }) => {
          localStorage.setItem("worklens.language", language);
          const invoke = window.worklens.invoke;
          window.worklens.invoke = async (method, input) => {
            // Slow the refresh after a save so a transient field error would be visible.
            if (method === "bootstrap" && window.slowBootstrap)
              await new Promise((resolve) => setTimeout(resolve, 800));
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
          name: t("Connect Tavily", "连接 Tavily"),
          exact: true,
        })
        .click();
      const dialog = page.getByRole("dialog", { name: "Tavily", exact: true });
      // The API address is prefilled so a proxy can replace it.
      await expect(dialog.locator("#tavily-url")).toHaveValue(
        "https://api.tavily.com",
      );
      await expect(dialog.locator("#tavily-token")).toHaveValue("");
      const testButton = dialog.getByRole("button", {
        name: t("Test connection", "测试连接"),
        exact: true,
      });
      const save = dialog.getByRole("button", {
        name: t("Save", "保存"),
        exact: true,
      });
      await expect(testButton).toBeDisabled();
      await expect(save).toBeDisabled();
      // New users are pointed at where keys come from; the link opens externally.
      await dialog
        .getByRole("link", { name: t("Get a free API key", "免费获取 API key") })
        .click();
      expect(
        await page.evaluate(() =>
          window.calls.filter((c) => c.name === "external").map((c) => c.input),
        ),
      ).toEqual([{ url: "https://app.tavily.com/home" }]);
      await expect(dialog).toBeVisible();
      await dialog.locator("#tavily-token").fill("tvly-synthetic-ui-key");
      await expect(testButton).toBeEnabled();
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        expect(
          await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth),
        ).toBe(true);
        await page.screenshot({
          path: info.outputPath(`tavily-dialog-${width}.png`),
        });
      }
      await testButton.click();
      await expect(
        page
          .locator('[data-slot="toast-title"]')
          .filter({ hasText: t("Connected to Tavily", "已连接 Tavily") }),
      ).toBeVisible();
      await page.evaluate(() => {
        window.slowBootstrap = true;
      });
      await save.click();
      // While the refresh is pending the token field must not be flagged as missing.
      await page.waitForTimeout(200);
      // Non-retrying on purpose: a retrying assertion would wait the flash out.
      expect(await dialog.getByRole("alert").count()).toBe(0);
      await expect(dialog).not.toBeVisible();
      await page.evaluate(() => {
        window.slowBootstrap = false;
      });
      const manage = content.getByRole("button", {
        name: t("Manage Tavily", "管理 Tavily"),
        exact: true,
      });
      await expect(manage).toBeVisible();
      // Connected rows show the address, matching the other connectors' height.
      await expect(
        content.getByText("https://api.tavily.com", { exact: true }),
      ).toBeVisible();
      await page.screenshot({ path: info.outputPath("tavily-connected.png") });
      await manage.click();
      await expect(dialog.getByText(`${t("Plan", "套餐")}: dev`)).toBeVisible();
      // A saved key can be re-tested without retyping it, but there is nothing
      // to save until something changes.
      await expect(dialog.locator("#tavily-token")).toHaveValue("");
      await expect(testButton).toBeEnabled();
      await expect(save).toBeDisabled();
      await dialog.locator("#tavily-token").press("Enter");
      expect(
        await page.evaluate(
          () => window.calls.filter((c) => c.name === "tavilySave").length,
        ),
      ).toBe(1);
      await dialog.locator("#tavily-url").fill("https://proxy.example.test");
      await expect(save).toBeDisabled(); // new address needs the key again
      await expect(testButton).toBeDisabled();
      await dialog.locator("#tavily-url").fill("https://api.tavily.com");
      await dialog.locator("#tavily-token").fill("tvly-rotated");
      await expect(save).toBeEnabled();
      await dialog.locator("#tavily-token").fill("");
      await expect(save).toBeDisabled();
      await dialog
        .getByRole("button", { name: t("Disconnect", "断开连接"), exact: true })
        .click();
      await page
        .getByRole("dialog", {
          name: t("Disconnect Tavily?", "断开 Tavily 的连接？"),
          exact: true,
        })
        .getByRole("button", { name: t("Disconnect", "断开连接"), exact: true })
        .click();
      await expect(dialog).not.toBeVisible();
      await expect(
        content.getByRole("button", {
          name: t("Connect Tavily", "连接 Tavily"),
          exact: true,
        }),
      ).toBeVisible();
    });
  }
