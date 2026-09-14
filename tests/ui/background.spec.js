import { test, expect } from "@playwright/test";
import { mockWorklens } from "./fixture.js";

test("dark appearance owns effects, saves quietly and preserves choices", async ({
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
  await page.getByRole("radio", { name: "Silver mist", exact: true }).click();
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
  ).toHaveCount(0);
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
    page.getByRole("radio", { name: "Silver mist", exact: true }),
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

 test("all effects and palettes render with a visible selection ring", async ({ page }, info) => {
 await mockWorklens(page); await page.goto("/");
 await page.getByRole("button", {name:"Settings",exact:true}).click();
 await page.getByRole("combobox", {name:"Appearance",exact:true}).selectOption("dark");
 await page.emulateMedia({ reducedMotion: "no-preference" });
 for (const effect of ["surface","aurora","fluid"]) {
  await page.getByRole("combobox", {name:"Background effect",exact:true}).selectOption(effect);
  for (const color of ["Blue violet","Jade","Silver mist","Dusk"]) {
   const choice=page.getByRole("radio", {name:color,exact:true}); await choice.click();
   await expect(choice).toBeChecked();
   await expect(choice).toHaveCSS("outline-style","solid");
   await expect(choice).toHaveCSS("transition-duration", "0s");
   await expect(choice).toHaveCSS("translate", "none");
   await expect(page.locator(".background-effect[data-fallback]")).toHaveCount(0);
  }
  await page.getByRole("radio", {name:"Blue violet",exact:true}).click();
  await expect(page.getByRole("radio", {name:"Blue violet",exact:true})).toBeChecked();
  await expect(page.getByRole("combobox", {name:"Background effect",exact:true})).toBeEnabled();
  await page.screenshot({path:info.outputPath(effect+".png")});
 }
});

 test("background save errors remain visible and preserve the selected effect", async ({ page }) => {
 await mockWorklens(page);
 await page.addInitScript(() => {
  const invoke = window.worklens.invoke;
  window.worklens.invoke = (name, input) => {
   if (name === "settings" && input?.backgroundEffect) return Promise.reject(new Error("fixture save failed"));
   return invoke(name, input);
  };
 });
 await page.goto("/");
 await page.getByRole("button", {name:"Settings",exact:true}).click();
 await page.getByRole("combobox", {name:"Appearance",exact:true}).selectOption("dark");
 await page.getByRole("combobox", {name:"Background effect",exact:true}).selectOption("fluid");
 await expect(page.locator('[data-slot="toast-title"]').filter({hasText:"Could not save background appearance."})).toBeVisible();
 await expect(page.getByRole("combobox", {name:"Background effect",exact:true})).toHaveValue("none");
 });
