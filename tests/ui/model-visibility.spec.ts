import { test, expect, type Page } from "@playwright/test";
import { mockWorklens } from "./fixture.js";

async function openModels(page: Page, large = false) {
  await mockWorklens(page, { largeModelCatalog: large });
  await page.addInitScript(() => {
    const original = window.worklens.invoke;
    (window as any).visibilityWrites = [];
    window.worklens.invoke = (async (name: any, input: any) => {
      if (name === "settings" && input.hiddenModels) {
        (window as any).visibilityWrites.push(input.hiddenModels);
        await new Promise((r) => setTimeout(r, 250));
      }
      return original(name, input);
    }) as typeof original;
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Models", exact: true }).click();
}
async function hidden(page: Page) {
  return page.evaluate(
    async () =>
      (await window.worklens.invoke("bootstrap", undefined)).settings
        .hiddenModels,
  );
}
async function bulk(page: Page, provider: string, label: string) {
  await page
    .getByRole("button", {
      name: `Manage model visibility: ${provider}`,
      exact: true,
    })
    .click();
  await page.getByRole("menuitem", { name: label, exact: true }).click();
}

test("bulk includes collapsed models, preserves other providers, persists and supports Undo", async ({
  page,
}) => {
  await openModels(page, true);
  await bulk(page, "DeepSeek", "Hide all 120 models from chat");
  await expect.poll(async () => (await hidden(page))?.length).toBe(120);
  expect(
    await page.evaluate(() => (window as any).visibilityWrites.length),
  ).toBe(1);
  await expect(
    page.getByRole("switch", { name: "Show in chat: GPT-5", exact: true }),
  ).toBeChecked();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(() => hidden(page)).toEqual([]);
  await bulk(page, "DeepSeek", "Hide all 120 models from chat");
  await expect.poll(async () => (await hidden(page))?.length).toBe(120);
  await page.reload();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Models", exact: true }).click();
  await expect(
    page.getByRole("switch", {
      name: "Show in chat: Catalog Alpha 0",
      exact: true,
    }),
  ).not.toBeChecked();
  await bulk(page, "DeepSeek", "Show all 120 models in chat");
  await expect.poll(() => hidden(page)).toEqual([]);
});

test("search scopes the batch beyond the first 50 and any provider supports bulk", async ({
  page,
}, info) => {
  await openModels(page, true);
  await page
    .getByRole("textbox", { name: "Search models", exact: true })
    .fill("Alpha");
  await bulk(page, "DeepSeek", "Hide 60 matching models from chat");
  await expect.poll(async () => (await hidden(page))?.length).toBe(60);
  expect((await hidden(page))?.includes("deepseek/model-59")).toBe(true);
  expect((await hidden(page))?.includes("deepseek/model-60")).toBe(false);
  await page
    .getByRole("textbox", { name: "Search models", exact: true })
    .clear();
  await bulk(page, "GitHub Copilot", "Hide all 3 models from chat");
  await expect.poll(async () => (await hidden(page))?.length).toBe(63);
  expect((await hidden(page))?.includes("github-copilot/restricted")).toBe(
    false,
  );
  await page
    .getByRole("button", {
      name: "Manage model visibility: DeepSeek",
      exact: true,
    })
    .click();
  await page.screenshot({ path: info.outputPath("bulk-models-light.png") });
  await page.keyboard.press("Escape");
  await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
  await page
    .getByRole("button", {
      name: "Manage model visibility: DeepSeek",
      exact: true,
    })
    .focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("menuitem", { name: "Show all 120 models in chat" }),
  ).toBeFocused();
  await page.screenshot({ path: info.outputPath("bulk-models-dark.png") });
});

test("failed bulk rolls back while a queued individual change still saves", async ({
  page,
}) => {
  await openModels(page);
  await page.evaluate(() => {
    (window as any).failNextVisibilitySave = true;
  });
  await bulk(page, "DeepSeek", "Hide all 2 models from chat");
  await page
    .getByRole("switch", { name: "Show in chat: GPT-5", exact: true })
    .click();
  await expect.poll(() => hidden(page)).toEqual(["github-copilot/gpt"]);
  await expect(
    page.getByRole("switch", {
      name: "Show in chat: DeepSeek V4 Flash",
      exact: true,
    }),
  ).toBeChecked();
  await expect(
    page.getByRole("switch", {
      name: "Show in chat: DeepSeek V4 Pro",
      exact: true,
    }),
  ).toBeChecked();
});

test("shown filter and Undo preserve a later individual change", async ({
  page,
}) => {
  await openModels(page);
  await bulk(page, "GitHub Copilot", "Hide all 3 models from chat");
  await expect.poll(async () => (await hidden(page))?.length).toBe(3);
  await page
    .getByRole("switch", { name: "Show in chat: GPT-5", exact: true })
    .click();
  await expect.poll(async () => (await hidden(page))?.length).toBe(2);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(() => hidden(page)).toEqual([]);
  await page
    .getByRole("combobox", { name: "Model filter" })
    .selectOption("visible");
  await bulk(page, "DeepSeek", "Hide 2 matching models from chat");
  await expect.poll(async () => (await hidden(page))?.length).toBe(2);
  await expect(
    page.getByRole("switch", { name: /Show in chat: DeepSeek/ }),
  ).toHaveCount(0);
});

test("tooltips wait on hover, sit beside model switches, dismiss on click, scroll and Escape", async ({
  page,
}, info) => {
  await openModels(page, true);
  const toggle = page.getByRole("switch", {
    name: "Show in chat: Catalog Alpha 0",
    exact: true,
  });
  await toggle.hover();
  await page.waitForTimeout(150);
  await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(0);
  const tooltip = page
    .locator('[data-slot="tooltip-content"]')
    .filter({ hasText: /^Show in chat$/ });
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveAttribute("data-side", "left");
  await page.screenshot({ path: info.outputPath("model-switch-tooltip.png") });
  await page.keyboard.press("Escape");
  await expect(tooltip).toBeHidden();
  await page.mouse.move(0, 0);
  await toggle.hover();
  await expect(tooltip).toBeVisible();
  await toggle.click();
  await expect(tooltip).toBeHidden();
  await expect(toggle).toBeEnabled();
  await page.mouse.move(0, 0);
  await toggle.hover();
  await expect(tooltip).toBeVisible();
  await page.locator(".settings-scroll").evaluate((el) => (el.scrollTop = 100));
  await expect(tooltip).toBeHidden();
});
