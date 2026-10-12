import { test, expect, type Page } from "@playwright/test";
import { mockWorklens } from "./fixture.js";

// Holds theme saves until the test releases them, and can fail one.
async function openAppearance(page: Page) {
  await mockWorklens(page);
  await page.addInitScript(() => {
    const invoke = (window as any).worklens.invoke;
    (window as any).worklens.invoke = async (name: string, input: any) => {
      if (name === "settings" && input?.theme) {
        await new Promise((resolve) => ((window as any).releaseSave = resolve));
        if ((window as any).failThemeSave) throw Error("Couldn’t save theme.");
      }
      return invoke(name, input);
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  return page.getByRole("combobox", { name: "Appearance" });
}

const theme = (page: Page) =>
  page.evaluate(() => document.documentElement.dataset.theme);

test("a theme applies before its save finishes", async ({ page }) => {
  const select = await openAppearance(page);
  await select.selectOption("dark");
  await expect.poll(() => theme(page)).toBe("dark");
  await expect(select).toHaveValue("dark");
  await page.evaluate(() => (window as any).releaseSave());
  await expect.poll(() => theme(page)).toBe("dark");
});

test("a theme that fails to save is undone", async ({ page }) => {
  const select = await openAppearance(page);
  await page.evaluate(() => ((window as any).failThemeSave = true));
  await select.selectOption("dark");
  await expect.poll(() => theme(page)).toBe("dark");
  await page.evaluate(() => (window as any).releaseSave());
  await expect.poll(() => theme(page)).toBe("light");
  await expect(select).toHaveValue("light");
});
