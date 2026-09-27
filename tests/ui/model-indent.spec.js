import { test, expect } from "@playwright/test";
import { mockWorklens } from "./fixture.js";

for (const theme of ["light", "dark"]) {
  test(`model cards keep external headings and compact rows: ${theme}`, async ({ page }, info) => {
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
      const headingBox = await page.locator(".settings-accordion-heading").first().boundingBox();
      expect(headingBox.y + headingBox.height).toBeLessThanOrEqual(parentBox.y);
      expect(rowBox.x - parentBox.x).toBeCloseTo(25, 0);
      expect(parentBox.x + parentBox.width - rowBox.x - rowBox.width).toBeCloseTo(25, 0);
      if (width === 1280) expect(rowBox.height).toBe(48);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`models-${width}.png`) });
    }
  });
}
