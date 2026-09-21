import { test, expect } from "@playwright/test";
import { mockWorklens } from "./fixture.js";

for (const theme of ["light", "dark"]) {
  test(`model names align with their provider label: ${theme}`, async ({ page }, info) => {
    await mockWorklens(page);
    await page.goto("/");
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.locator(".settings-navigation").getByRole("button", { name: "Models", exact: true }).click();
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const panel = page.locator(".settings-model-panel").first();
      const row = panel.locator(".settings-entry").first();
      await expect(row).toBeVisible();
      await expect(row).toHaveCSS("padding-left", "0px");
      await expect(row).toHaveCSS("padding-right", "0px");
      await expect(row).toHaveCSS("padding-top", "10px");
      const parentBox = await page.locator('[data-slot="accordion-content"]').first().boundingBox();
      const rowBox = await row.boundingBox();
      const brandBox = await page.locator('[data-slot="model-provider-name"]').first().boundingBox();
      const nameBox = await row.locator(".settings-entry-title").boundingBox();
      expect(nameBox.x).toBeCloseTo(brandBox.x, 0);
      expect(rowBox.x + rowBox.width).toBeCloseTo(parentBox.x + parentBox.width, 0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`models-${width}.png`) });
    }
  });
}
