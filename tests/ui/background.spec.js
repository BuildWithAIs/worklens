import { test, expect } from "@playwright/test";
import { mockWorklens } from "./fixture.js";

test("dark appearance owns effects, confirms saves and preserves choices", async ({
  page,
}, info) => {
  await mockWorklens(page);
  await page.goto("/");
  const settings = () =>
    page.getByRole("button", { name: "Settings", exact: true }).click();
  await settings();
  await expect(
    page.getByRole("combobox", { name: "Background effect" }),
  ).toHaveCount(0);
  await page
    .getByRole("combobox", { name: "Appearance", exact: true })
    .selectOption("dark");
  await expect(
    page.getByRole("combobox", { name: "Background effect", exact: true }),
  ).toHaveValue("none");
  await expect(page.locator(".background-effect")).toHaveCount(0);
  await page
    .getByRole("combobox", { name: "Background effect", exact: true })
    .selectOption("surface");
  await expect(
    page.getByRole("combobox", { name: "Background effect", exact: true }),
  ).toHaveValue("surface");
  await expect(
    page.getByRole("radio", { name: "Blue violet", exact: true }),
  ).toBeChecked();
  await page.getByRole("radio", { name: "Glacier blue", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Background effect", exact: true })
    .selectOption("fluid");
  await expect(
    page.getByRole("combobox", { name: "Background effect", exact: true }),
  ).toHaveValue("fluid");
  await expect(
    page
      .locator('[data-slot="toast-title"]')
      .filter({ hasText: "Saved" })
      .first(),
  ).toBeVisible();
  await expect(page.locator(".background-effect[data-fallback]")).toHaveCount(
    0,
  );
  await expect(
    page.locator(".background-effect canvas").first(),
  ).toHaveAttribute("data-motion", "static");
  await page.evaluate(() => {
    document.documentElement.dataset.nativeVibrancy = "true";
  });
  await page.mouse.move(600, 20);
  await page.screenshot({
    path: info.outputPath("settings-background.png"),
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Back to app", exact: true }).click();
  await expect(page.locator(".background-effect")).toHaveCount(1);
  await expect(
    page.locator(".sidebar .background-effect[data-fallback]"),
  ).toHaveCount(0);
  await expect(page.locator(".sidebar canvas")).toHaveAttribute(
    "data-motion",
    "static",
  );
  await page.screenshot({
    path: info.outputPath("home-background.png"),
    animations: "disabled",
  });
  await page.reload();
  await settings();
  await expect(
    page.getByRole("combobox", { name: "Background effect", exact: true }),
  ).toHaveValue("fluid");
  await expect(
    page.getByRole("radio", { name: "Glacier blue", exact: true }),
  ).toBeChecked();
  await page
    .getByRole("combobox", { name: "Appearance", exact: true })
    .selectOption("light");
  await expect(page.locator(".background-effect")).toHaveCount(0);
  await expect(
    page.getByRole("combobox", { name: "Background effect" }),
  ).toHaveCount(0);
  await page.emulateMedia({ colorScheme: "dark" });
  await page
    .getByRole("combobox", { name: "Appearance", exact: true })
    .selectOption("system");
  await expect(
    page.getByRole("combobox", { name: "Background effect", exact: true }),
  ).toHaveValue("fluid");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator(".background-effect")).toHaveCount(0);
  await page.emulateMedia({
    colorScheme: "dark",
    reducedMotion: "no-preference",
  });
  await expect(
    page.locator(".background-effect canvas").first(),
  ).toHaveAttribute("data-motion", "running");
  await page.setViewportSize({ width: 390, height: 900 });
  await page.screenshot({
    path: info.outputPath("settings-background-narrow.png"),
    animations: "disabled",
  });
  await page
    .getByRole("combobox", { name: "Background effect", exact: true })
    .selectOption("none");
  await expect(page.locator(".background-effect")).toHaveCount(0);
});

test("unsupported WebGL falls back without affecting settings", async ({
  page,
}) => {
  await mockWorklens(page);
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      return type === "webgl" ? null : original.call(this, type, ...args);
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Appearance", exact: true })
    .selectOption("dark");
  await page
    .getByRole("combobox", { name: "Background effect", exact: true })
    .selectOption("surface");
  await expect(page.locator(".background-effect[data-fallback]")).toHaveCount(
    2,
  );
});

test("shader opacity fades in instead of covering native glass with a hard edge", async ({
  page,
}) => {
  await mockWorklens(page);
  await page.addInitScript(() => {
    const draw = WebGLRenderingContext.prototype.drawArrays;
    WebGLRenderingContext.prototype.drawArrays = function (...args) {
      draw.apply(this, args);
      const pixel = new Uint8Array(4);
      this.readPixels(
        4,
        Math.floor(this.canvas.height * 0.75),
        1,
        1,
        this.RGBA,
        this.UNSIGNED_BYTE,
        pixel,
      );
      this.canvas.dataset.fadeAlpha = String(pixel[3]);
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Appearance", exact: true })
    .selectOption("dark");
  await page
    .getByRole("combobox", { name: "Background effect", exact: true })
    .selectOption("fluid");
  const canvas = page.locator(".settings-navigation canvas");
  await expect
    .poll(async () => Number(await canvas.getAttribute("data-fade-alpha")))
    .toBeGreaterThan(0);
  expect(Number(await canvas.getAttribute("data-fade-alpha"))).toBeLessThan(20);
});
