import { test, expect } from "@playwright/test";
import { mockWorklens } from "../fixture.js";

for (const language of ["en", "zh"]) {
  test(`Confluence manages several sites: ${language}`, async ({
    page,
  }, info) => {
    await mockWorklens(page);
    await page.addInitScript((language) => {
      localStorage.setItem("worklens.language", language);
    }, language);
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
    const dialog = page.getByRole("dialog", {
      name: "Confluence",
      exact: true,
    });
    const save = dialog.getByRole("button", {
      name: t("Save", "保存"),
      exact: true,
    });
    const first = "https://wiki-a.example.test/confluence";
    const second = "https://wiki-b.example.test";

    await content
      .getByRole("button", {
        name: t("Connect Confluence", "连接 Confluence"),
        exact: true,
      })
      .click();
    await expect(
      dialog.getByRole("switch", { name: t("Read-only", "只读") }),
    ).not.toBeChecked();
    await dialog.locator("#confluence-url").fill(first);
    await dialog.locator("#confluence-token").fill("synthetic-token-a");
    await save.click();
    await expect(dialog).not.toBeVisible();

    const addSite = content.getByRole("button", {
      name: t("Add Confluence site", "添加 Confluence 站点"),
      exact: true,
    });
    await addSite.click();
    await expect(dialog.locator("#confluence-url")).toHaveValue("");
    await expect(
      dialog.getByRole("button", { name: t("Disconnect", "断开连接") }),
    ).toHaveCount(0);
    await dialog.locator("#confluence-url").fill(second);
    await dialog.locator("#confluence-token").fill("synthetic-token-b");
    await dialog.getByRole("switch", { name: t("Read-only", "只读") }).click();
    await expect(dialog.locator("#confluence-read-only-hint")).toContainText(
      t("only search and read", "只能搜索和读取"),
    );
    await save.click();
    await expect(dialog).not.toBeVisible();

    // Each site is its own row, told apart by address, like other connectors.
    const rows = content.locator('[data-connection="confluence"]');
    await expect(rows).toHaveCount(3);
    const siteA = content.locator('[data-connection-instance="primary"]');
    const siteB = content.locator('[data-connection-instance="site-2"]');
    await expect(siteA).toContainText(first);
    await expect(siteA.getByText(t("Read-only", "只读"))).toHaveCount(0);
    await expect(siteB).toContainText(second);
    await expect(
      siteB.getByText(t("Read-only", "只读"), { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("tab", { name: new RegExp(t("Built-in", "内置")) }),
    ).toContainText("2");
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await content.evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
      await page.screenshot({
        path: info.outputPath(`confluence-sites-${width}.png`),
      });
    }
    await page.setViewportSize({ width: 1280, height: 900 });

    // The same site cannot be added twice.
    await addSite.click();
    await dialog.locator("#confluence-url").fill(first + "/");
    await dialog.locator("#confluence-token").fill("synthetic-token-c");
    await save.click();
    await expect(
      page.locator('[data-slot="toast-description"]').filter({
        hasText: t(
          "This Confluence site has already been added.",
          "已添加过这个 Confluence 站点。",
        ),
      }),
    ).toBeVisible();
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");

    // A read-only change alone can be saved without re-entering the token.
    const manageB = content.getByRole("button", {
      name: `${t("Manage", "管理")} Confluence ${second}`,
      exact: true,
    });
    await manageB.click();
    await expect(save).toBeDisabled();
    await dialog.getByRole("switch", { name: t("Read-only", "只读") }).click();
    await expect(save).toBeEnabled();
    await save.click();
    await expect(dialog).not.toBeVisible();
    await expect(siteB.getByText(t("Read-only", "只读"))).toHaveCount(0);
    const saves = await page.evaluate(() =>
      window.calls.filter((call) => call.name === "confluenceSave"),
    );
    expect(saves.map((call) => call.input)).toMatchObject([
      { url: first, readOnly: false },
      { url: second, readOnly: true },
      { url: first + "/" },
      { url: second, site: "site-2", readOnly: false, token: "" },
    ]);
    expect(saves[0].input.site).toBeUndefined();
    expect(saves[1].input.site).toBeUndefined();

    // Removing one site keeps the other.
    await content
      .getByRole("button", {
        name: `${t("Manage", "管理")} Confluence ${first}`,
        exact: true,
      })
      .click();
    await dialog
      .getByRole("button", { name: t("Disconnect", "断开连接"), exact: true })
      .click();
    await page
      .getByRole("dialog", {
        name: t("Disconnect Confluence?", "断开 Confluence 的连接？"),
        exact: true,
      })
      .getByRole("button", { name: t("Disconnect", "断开连接"), exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
    await expect(siteA).toHaveCount(0);
    await expect(siteB).toContainText(second);
    expect(
      await page.evaluate(() =>
        window.calls
          .filter((call) => call.name === "confluenceRemove")
          .map((call) => call.input),
      ),
    ).toEqual([{ site: "primary" }]);
    // With one site left, its action no longer needs the address.
    await expect(
      content.getByRole("button", {
        name: t("Manage Confluence", "管理 Confluence"),
        exact: true,
      }),
    ).toBeVisible();
  });
}
