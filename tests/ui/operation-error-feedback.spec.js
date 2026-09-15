import { test, expect } from "@playwright/test";
import { mockWorklens } from "./fixture.js";

test("Providers and Models report operation failures only in Toast", async ({
  page,
}) => {
  await mockWorklens(page);
  await page.addInitScript(() => {
    const invoke = window.worklens.invoke;
    window.worklens.invoke = (method, input) => {
      if (method === "test")
        return Promise.reject(new Error("Model connection unavailable"));
      if (method === "login")
        return Promise.reject(new Error("Provider connection unavailable"));
      return invoke(method, input);
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Models", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Search models", exact: true })
    .fill("DeepSeek");
  await page
    .getByRole("button", {
      name: "Test connection: DeepSeek V4 Flash",
      exact: true,
    })
    .click();
  await expect(
    page
      .locator('[data-slot="toast-description"]')
      .filter({ hasText: "Model connection unavailable" }),
  ).toBeVisible();
  await expect(
    page
      .locator('[data-slot="toast-title"]')
      .filter({ hasText: "Couldn’t connect to DeepSeek V4 Flash" }),
  ).toBeVisible();
  await expect(page.locator(".model-test-result")).toHaveCount(0);
  await page.getByRole("button", { name: "Providers", exact: true }).click();
  await page
    .locator(".settings-entry")
    .filter({ has: page.getByText("OpenAI", { exact: true }) })
    .getByRole("button", { name: "Connect", exact: true })
    .click();
  await expect(
    page
      .locator('[data-slot="toast-description"]')
      .filter({ hasText: "Provider connection unavailable" }),
  ).toBeVisible();
  await expect(
    page
      .locator('[data-slot="toast-title"]')
      .filter({ hasText: "Couldn’t sign in to OpenAI" }),
  ).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("alert")).toHaveCount(0);
});
