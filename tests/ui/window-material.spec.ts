import { test, expect } from "@playwright/test";
import { mockWorklens } from "./fixture.js";

test("native material stays covered while bootstrap is loading", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await mockWorklens(page);
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      document.documentElement.dataset.nativeVibrancy = "true";
    });
    const invoke = window.worklens.invoke;
    window.worklens.invoke = async (method, input) => {
      if (method === "bootstrap") {
        await new Promise<void>((resolve) => {
          window.addEventListener("release-bootstrap", () => resolve(), {
            once: true,
          });
        });
      }
      return invoke(method, input);
    };
  });
  await page.goto("/");
  await expect(page.locator(".loading")).toBeVisible();
  await expect(page.locator("html")).toHaveCSS(
    "background-color",
    "rgb(250, 250, 250)",
  );
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(255, 255, 255)",
  );
  await page.evaluate(() =>
    window.dispatchEvent(new Event("release-bootstrap")),
  );
  await expect(page.locator(".sidebar")).toBeVisible();
  await expect(page.locator("html")).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await expect(page.locator(".main-content")).toHaveCSS(
    "background-color",
    "rgb(255, 255, 255)",
  );
});
