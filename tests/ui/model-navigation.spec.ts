import { test, expect } from "@playwright/test";
import { mockWorklens } from "./fixture.js";

test("first launch stays in chat and both connection shortcuts open Providers", async ({
  page,
}, info) => {
  await mockWorklens(page, { modelState: "unconfigured" });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Choose model", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "Settings", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Choose model", exact: true }).click();
  await expect(
    page.getByText("Connect a provider to choose a model.", { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("first-launch-picker.png") });
  await page
    .getByRole("button", { name: "Connect a provider", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Providers", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Models", exact: true }).click();
  await expect(
    page.getByText("No providers connected", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Connect a provider to use its models.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Go to Providers", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("models-connect-empty.png") });
  await page
    .getByRole("button", { name: "Go to Providers", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Providers", exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Models", exact: true }).click();
  const search = page.getByRole("textbox", {
    name: "Search models",
    exact: true,
  });
  await search.fill("no-such-model");
  await expect(
    page.getByText(
      "No models match these filters. Try another search or filter.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Go to Providers", exact: true }),
  ).toHaveCount(0);
  await search.clear();
  await page
    .getByRole("combobox", { name: "Model filter" })
    .selectOption("visible");
  await expect(
    page.getByRole("button", { name: "Go to Providers", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("combobox", { name: "Model filter" })
    .selectOption("all");
  await expect(
    page.locator('[data-slot="accordion-item"]').first(),
  ).toBeVisible();
});

test("model groups link to their provider without opening authentication in Models", async ({
  page,
}, info) => {
  await mockWorklens(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Search providers", exact: true })
    .fill("DeepSeek");
  await page
    .getByRole("combobox", { name: "Filter providers", exact: true })
    .selectOption("connected");
  await page.getByRole("button", { name: "Models", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Model filter" })
    .selectOption("all");
  await page
    .getByRole("textbox", { name: "Search models", exact: true })
    .fill("Anthropic");
  await expect(page.getByText("Claude Sonnet", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Connect", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("models-provider-shortcut.png"),
  });
  await page
    .getByRole("button", { name: "Go to Providers: Anthropic", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Providers", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Search providers", exact: true }),
  ).toHaveValue("Anthropic");
  await expect(
    page.getByRole("combobox", { name: "Filter providers", exact: true }),
  ).toHaveValue("all");
  await expect(page.locator(".settings-entry")).toHaveCount(1);
  await expect(page.locator("input[type=password]")).toHaveCount(0);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator("input[type=password]")).toBeVisible();
});

for (const modelState of ["unavailable", "hidden", "available"] as const) {
  test(`configured providers open Models when models are ${modelState}`, async ({
    page,
  }) => {
    await mockWorklens(page, modelState === "available" ? {} : { modelState });
    await page.goto("/");
    await page
      .getByRole("button", { name: "Choose model", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "Settings", exact: true }),
    ).toHaveCount(0);
    if (modelState !== "available") {
      await expect(page.locator("[data-model-option]")).toHaveCount(0);
    }
    await page
      .getByRole("button", { name: "Manage models", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Models", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("textbox", { name: "Search models", exact: true })
      .fill("no-such-model");
    await expect(
      page.getByText(
        "No models match these filters. Try another search or filter.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Go to Providers", exact: true }),
    ).toHaveCount(0);
  });
}

for (const allUnavailable of [true, false]) {
  test(`unavailable selection hides Thinking with other models ${allUnavailable ? "unavailable" : "available"}`, async ({
    page,
  }, info) => {
    await mockWorklens(page, {
      unavailableSelection: true,
      ...(allUnavailable ? { modelState: "unavailable" as const } : {}),
    });
    await page.goto("/");
    const picker = page.getByRole("button", {
      name: "Choose model",
      exact: true,
    });
    await expect(picker).toContainText("DeepSeek V4 Flash");
    await expect(picker).not.toContainText("Medium");
    await picker.click();
    await expect(page.locator(".chat-model-reasoning")).toHaveCount(0);
    await expect(
      page.getByRole("combobox", { name: "Thinking level", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Manage models", exact: true }),
    ).toBeVisible();
    const defaults = await page.evaluate(async () => {
      const data = await window.worklens.invoke("bootstrap", undefined);
      return data.settings.defaults;
    });
    expect(defaults).toEqual({
      provider: "deepseek",
      model: "flash",
      thinking: "medium",
    });
    await page.screenshot({
      path: info.outputPath("unavailable-model-thinking-hidden.png"),
    });
    if (allUnavailable) {
      await expect(page.locator("[data-model-option]")).toHaveCount(0);
    } else {
      await page
        .locator("[data-model-option]")
        .filter({ hasText: "DeepSeek V4 Pro" })
        .click();
      await expect(
        page.getByRole("combobox", { name: "Thinking level", exact: true }),
      ).toHaveValue("medium");
      await page.keyboard.press("Escape");
      await expect(picker).toContainText("DeepSeek V4 Pro");
      await expect(picker).toContainText("Medium");
    }
  });
}
