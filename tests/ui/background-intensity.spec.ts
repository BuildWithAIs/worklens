import { test, expect, type Page } from "@playwright/test";
import { mockWorklens } from "./fixture.js";

async function setup(page: Page, fallback = false) {
  await mockWorklens(page);
  await page.addInitScript((fallback) => {
    const invoke = window.worklens.invoke;
    (window as any).intensityWrites = [];
    window.worklens.invoke = (async (name: any, input: any) => {
      if (name === "settings" && input.backgroundIntensity) {
        (window as any).intensityWrites.push(input.backgroundIntensity);
      }
      return invoke(name, input);
    }) as typeof invoke;
    if (fallback) {
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (
        this: HTMLCanvasElement,
        type: string,
        ...args: any[]
      ) {
        return type === "webgl"
          ? null
          : getContext.apply(this, [type, ...args] as any);
      } as typeof getContext;
    }
  }, fallback);
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
}
const slider = (page: Page) =>
  page.getByRole("slider", { name: "Intensity", exact: true });
const effect = (page: Page) =>
  page.getByRole("combobox", { name: "Background effect", exact: true });
const saved = (page: Page) =>
  page.evaluate(
    async () =>
      (await window.worklens.invoke("bootstrap", undefined)).settings
        .backgroundIntensity,
  );

test("drag previews without saving, commits once, preserves per-effect values and reloads", async ({
  page,
}, info) => {
  await setup(page);
  await expect(slider(page)).toHaveCount(0);
  await effect(page).selectOption("surface");
  await expect(slider(page)).toHaveValue("50");
  await expect(
    page.locator(".settings-navigation .background-effect"),
  ).toHaveAttribute("data-intensity", "50");
  const track = await page
    .locator(".background-intensity-control")
    .boundingBox();
  const thumb = await page.locator(".background-intensity-thumb").boundingBox();
  await page.mouse.move(
    thumb!.x + thumb!.width / 2,
    thumb!.y + thumb!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    track!.x + track!.width * 0.8,
    track!.y + track!.height / 2,
    { steps: 8 },
  );
  const value = await slider(page).inputValue();
  expect(Number(value)).toBeGreaterThan(70);
  expect(await saved(page)).toBeUndefined();
  await expect(
    page.locator(".settings-navigation .background-effect"),
  ).toHaveAttribute("data-intensity", value);
  await page.mouse.up();
  await expect
    .poll(async () => (await saved(page))?.surface)
    .toBe(Number(value));
  expect(
    await page.evaluate(() => (window as any).intensityWrites.length),
  ).toBe(1);
  await page.screenshot({ path: info.outputPath("intensity-light.png") });
  await effect(page).selectOption("aurora");
  await expect(slider(page)).toHaveValue("50");
  await slider(page).press("End");
  await expect.poll(async () => (await saved(page))?.aurora).toBe(100);
  await effect(page).selectOption("surface");
  await expect(slider(page)).toHaveValue(value);
  await effect(page).selectOption("none");
  await expect(slider(page)).toHaveCount(0);
  await effect(page).selectOption("surface");
  await expect
    .poll(async () =>
      page.evaluate(
        async () =>
          (await window.worklens.invoke("bootstrap", undefined)).settings
            .backgroundEffect,
      ),
    )
    .toBe("surface");
  await page.reload();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(slider(page)).toHaveValue(value);
  await slider(page).press("Home");
  await expect.poll(async () => (await saved(page))?.surface).toBe(0);
  expect((await saved(page))?.aurora).toBe(100);
  await expect(page.locator('[data-slot="toast"]')).toHaveCount(0);
  await page
    .getByRole("combobox", { name: "Appearance", exact: true })
    .selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await slider(page).focus();
  await page.screenshot({ path: info.outputPath("intensity-dark.png") });
  await page.setViewportSize({ width: 740, height: 820 });
  await page.screenshot({ path: info.outputPath("intensity-narrow.png") });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("failed commit restores the saved value and preview, keyboard can retry", async ({
  page,
}) => {
  await setup(page);
  await effect(page).selectOption("fluid");
  await page.evaluate(() => {
    (window as any).failNextBackgroundSave = true;
  });
  await slider(page).press("End");
  await expect(
    page
      .locator('[data-slot="toast-title"]')
      .filter({ hasText: "Could not save background appearance." }),
  ).toBeVisible();
  await expect(slider(page)).toHaveValue("50");
  await expect(
    page.locator(".settings-navigation .background-effect"),
  ).toHaveAttribute("data-intensity", "50");
  expect(await saved(page)).toBeUndefined();
  await slider(page).press("Home");
  await expect.poll(async () => (await saved(page))?.fluid).toBe(0);
});

test("WebGL fallback responds to intensity in both themes", async ({
  page,
}) => {
  await setup(page, true);
  await effect(page).selectOption("surface");
  const background = page.locator(".settings-navigation .background-effect");
  await expect(background).toHaveAttribute("data-fallback");
  const initial = await background.evaluate(
    (el) => getComputedStyle(el).backgroundImage,
  );
  await slider(page).press("Home");
  await expect.poll(async () => (await saved(page))?.surface).toBe(0);
  expect(
    await background.evaluate((el) => getComputedStyle(el).backgroundImage),
  ).not.toBe(initial);
  await page
    .getByRole("combobox", { name: "Appearance", exact: true })
    .selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await slider(page).press("End");
  await expect.poll(async () => (await saved(page))?.surface).toBe(100);
  await expect(background).toHaveAttribute("data-intensity", "100");
});
