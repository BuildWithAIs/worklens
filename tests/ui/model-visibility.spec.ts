import { test, expect, type Page } from "@playwright/test";
import { mockWorklens } from "./fixture.js";

async function openModels(page: Page, large = false) {
  await mockWorklens(page, { largeModelCatalog: large });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Models", exact: true }).click();
}
async function manage(page: Page, provider = "DeepSeek") {
  await page
    .getByRole("button", { name: `Select models: ${provider}`, exact: true })
    .click();
  return page.getByRole("dialog", {
    name: `${provider} models`,
    exact: true,
  });
}
async function hidden(page: Page) {
  return page.evaluate(
    async () =>
      (await window.worklens.invoke("bootstrap", undefined)).settings
        .hiddenModels,
  );
}

test("new candidates come first, search covers the catalog, and checking a row keeps it in place", async ({
  page,
}) => {
  await mockWorklens(page, {
    initialSettings: {
      hiddenModels: ["deepseek/pro"],
      modelCatalogs: { deepseek: { known: ["flash", "pro"], new: ["pro"] } },
    },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Models", exact: true }).click();
  const group = page.locator(".settings-accordion-heading").filter({
    hasText: "DeepSeek",
  });
  const disclosure = group.locator('[data-slot="accordion-trigger"]');
  await expect(group.locator(".settings-group-count")).toHaveText(
    "1 / 2 added",
  );
  await group.locator(".settings-group-count").click();
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await disclosure.focus();
  await page.keyboard.press("Enter");
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");
  const headingBox = (await group.boundingBox())!;
  await page.mouse.click(
    headingBox.x + headingBox.width / 2,
    headingBox.y + headingBox.height / 2,
  );
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await expect(group.locator(".settings-group-count")).toBeVisible();
  await group.locator(".settings-group-count").click();
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");
  await page.mouse.click(
    headingBox.x + 2,
    headingBox.y + headingBox.height / 2,
  );
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  const dialog = await manage(page);
  const rows = dialog.locator(".settings-model-option:visible");
  await expect(rows.first()).toContainText("DeepSeek V4 Pro");
  const before = await rows.first().boundingBox();
  await rows.first().getByText("DeepSeek V4 Pro", { exact: true }).click();
  await expect(
    dialog.getByRole("checkbox", { name: "DeepSeek V4 Pro", exact: true }),
  ).toBeChecked();
  expect(await rows.first().boundingBox()).toEqual(before);
  expect(await hidden(page)).toEqual(["deepseek/pro"]);
  await dialog
    .getByRole("checkbox", { name: "DeepSeek V4 Flash", exact: true })
    .uncheck();
  await expect(dialog.getByRole("status")).toHaveText("1 / 2 selected");
  const listHeight = (await dialog
    .locator(".settings-model-options")
    .boundingBox())!.height;
  const search = dialog.getByRole("textbox", {
    name: "Search models",
    exact: true,
  });
  for (const name of ["Pro", "Flash"]) {
    await search.fill(name);
    await expect(dialog.getByRole("status")).toHaveText(
      "1 / 2 selected · 1 matching",
    );
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText(`DeepSeek V4 ${name}`);
  }
  await search.fill("missing model");
  await expect(
    dialog.getByText("No matching models. Try another name or model ID.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(
    (await dialog.locator(".settings-model-options").boundingBox())!.height,
  ).toBe(listHeight);
  await expect(dialog.locator('[data-slot="dialog-footer"]')).toHaveText(
    "CancelSave",
  );
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await expect(group.locator(".settings-group-count")).toHaveText(
    "1 / 2 added",
  );
  await disclosure.focus();
  await page.keyboard.press("Space");
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");
});

test("refresh lives in the editor and preserves draft choices on success and failure", async ({
  page,
}) => {
  await mockWorklens(page);
  await page.addInitScript(() => {
    const invoke = window.worklens.invoke;
    let refreshed = false;
    window.worklens.invoke = (async (name: any, input: any) => {
      if (name === "refreshModels") {
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (refreshed) throw new Error("Local refresh failure");
        refreshed = true;
      }
      const result = await invoke(name, input);
      if (name === "bootstrap" && refreshed) {
        const data = result as any;
        const provider = data.providers.find(
          (item: any) => item.id === "deepseek",
        );
        const pro = provider.models.find((model: any) => model.id === "pro");
        provider.models = [
          { ...pro, contextWindow: 256000 },
          { ...pro, id: "discovered", name: "New catalog model" },
        ];
        data.settings.modelCatalogs.deepseek = {
          known: ["flash", "pro", "discovered"],
          new: ["discovered"],
        };
        data.settings.hiddenModels = [
          ...new Set([...data.settings.hiddenModels, "deepseek/discovered"]),
        ];
      }
      return result;
    }) as typeof invoke;
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Models", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Refresh models: DeepSeek", exact: true }),
  ).toHaveCount(0);
  const dialog = await manage(page);
  const pro = dialog.getByRole("checkbox", {
    name: "DeepSeek V4 Pro",
    exact: true,
  });
  const flash = dialog.getByRole("checkbox", {
    name: "DeepSeek V4 Flash",
    exact: true,
  });
  await pro.uncheck();
  await dialog
    .getByRole("textbox", { name: "Search models", exact: true })
    .fill("Pro");
  const refresh = dialog.getByRole("button", {
    name: "Refresh models: DeepSeek",
    exact: true,
  });
  await refresh.click();
  await expect(
    dialog.getByRole("button", { name: "Save", exact: true }),
  ).toBeDisabled();
  await expect(dialog.getByRole("status")).toHaveText(
    "1 / 3 selected · 1 matching",
  );
  await expect(pro).not.toBeChecked();
  await expect(
    dialog.getByText("256K · Thinking", { exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole("textbox", { name: "Search models", exact: true })
    .fill("");
  await expect(flash).toBeChecked();
  await expect(flash).toBeEnabled();
  await expect(
    dialog.getByRole("checkbox", { name: "New catalog model", exact: true }),
  ).not.toBeChecked();
  await expect(dialog.locator(".settings-model-option").first()).toContainText(
    "New catalog model",
  );
  await refresh.click();
  await expect(
    page
      .getByRole("region", { name: "Notifications", exact: true })
      .getByText("Your choices are kept. Try refreshing again.", {
        exact: false,
      }),
  ).toBeVisible();
  await expect(dialog.getByRole("status")).toHaveText("1 / 3 selected");
  await expect(flash).toBeChecked();
  await expect(pro).not.toBeChecked();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
  const calls = await page.evaluate(() =>
    (window as any).calls.filter((call: any) => call.name === "modelSelection"),
  );
  expect(calls).toHaveLength(1);
  expect(calls[0].input.selected).toEqual(["flash"]);
  expect(calls[0].input.reviewed).toEqual(
    expect.arrayContaining(["flash", "pro", "discovered"]),
  );
});

test("search preserves the saved total and bulk selection excludes unavailable models", async ({
  page,
}) => {
  await mockWorklens(page, {
    initialSettings: {
      hiddenModels: ["github-copilot/restricted", "github-copilot/gpt"],
    },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Models", exact: true }).click();
  const search = page.getByRole("textbox", {
    name: "Search models",
    exact: true,
  });
  await search.fill("Sonnet");
  await expect(
    page
      .locator(".settings-accordion-heading")
      .filter({ hasText: "GitHub Copilot" })
      .locator(".settings-group-count"),
  ).toHaveText("2 / 4 added · 1 matching");
  await search.fill("");
  const dialog = await manage(page, "GitHub Copilot");
  await expect(
    dialog.getByRole("checkbox", { name: "Restricted model", exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByText(
      "Not available with the current connection. Manage authentication in Providers.",
      { exact: true },
    ),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Select all", exact: true }).click();
  await expect(
    dialog.getByRole("checkbox", { name: "GPT-5", exact: true }),
  ).toBeChecked();
  await expect(
    dialog.getByRole("checkbox", { name: "Restricted model", exact: true }),
  ).not.toBeChecked();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(await hidden(page)).toEqual(["github-copilot/restricted"]);
});

test("draft edits cancel without writing; save clears a large catalog and keeps its management entry", async ({
  page,
}) => {
  await openModels(page, true);
  let dialog = await manage(page);
  await dialog
    .getByRole("button", { name: "Deselect all", exact: true })
    .click();
  expect(await hidden(page)).toEqual([]);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  dialog = await manage(page);
  await expect(
    dialog.getByRole("checkbox", { name: "Catalog Alpha 0", exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Deselect all", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect((await hidden(page))?.length).toBe(120);
  await expect(
    page
      .locator(".settings-list")
      .getByText(
        "No models added. Use Select models to choose models for your chat menu.",
        {
          exact: true,
        },
      ),
  ).toBeVisible();
  await expect(page.getByText("GPT-5", { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Models", exact: true }).click();
  dialog = await manage(page);
  await expect(
    dialog.getByRole("checkbox", { name: "Catalog Alpha 0", exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Select all", exact: true }).click();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(await hidden(page)).toEqual([]);
});

test("search batches include every match and preserve non-matching models", async ({
  page,
}) => {
  await openModels(page, true);
  const dialog = await manage(page);
  await dialog
    .getByRole("textbox", { name: "Search models", exact: true })
    .fill("Alpha");
  await dialog
    .getByRole("button", { name: "Deselect results", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
  const ids = await hidden(page);
  expect(ids?.length).toBe(60);
  expect(ids).toContain("deepseek/model-59");
  expect(ids).not.toContain("deepseek/model-60");
});

test("failed save retains draft, leaves current choices unchanged, and can retry", async ({
  page,
}) => {
  await openModels(page);
  const dialog = await manage(page);
  await dialog
    .getByRole("checkbox", { name: "DeepSeek V4 Pro", exact: true })
    .click();
  await page.evaluate(() => {
    (window as any).failNextVisibilitySave = true;
  });
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Save", exact: true }),
  ).toBeEnabled();
  expect(await hidden(page)).toEqual([]);
  await expect(
    dialog.getByRole("checkbox", { name: "DeepSeek V4 Pro", exact: true }),
  ).not.toBeChecked();
  await expect(
    page
      .getByRole("region", { name: "Notifications", exact: true })
      .getByText("Your changes are kept. Try saving again.", {
        exact: false,
      }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(await hidden(page)).toEqual(["deepseek/pro"]);
});

test("New badges survive cancel and restart, clear on save, and do not select models", async ({
  page,
}) => {
  await mockWorklens(page, {
    initialSettings: {
      hiddenModels: ["deepseek/pro"],
      modelCatalogs: { deepseek: { known: ["flash", "pro"], new: ["pro"] } },
    },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Models", exact: true }).click();
  let dialog = await manage(page);
  await expect(dialog.getByText("New", { exact: true })).toHaveCount(1);
  await expect(
    dialog.getByRole("checkbox", { name: "DeepSeek V4 Pro", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.reload();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Models", exact: true }).click();
  dialog = await manage(page);
  await expect(dialog.getByText("New", { exact: true })).toHaveCount(1);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
  dialog = await manage(page);
  await expect(dialog.getByText("New", { exact: true })).toHaveCount(0);
  expect(await hidden(page)).toContain("deepseek/pro");
});

test("filtered models leave keyboard navigation and clearing search preserves draft choices", async ({
  page,
}) => {
  await openModels(page, true);
  const dialog = await manage(page);
  const search = dialog.getByRole("textbox", {
    name: "Search models",
    exact: true,
  });
  await search.fill("model-11");
  await expect(dialog.getByRole("checkbox")).toHaveCount(11);
  const first = dialog.getByRole("checkbox", {
    name: "Catalog Alpha 11",
    exact: true,
  });
  await first.focus();
  await page.keyboard.press("Space");
  await expect(first).not.toBeChecked();
  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("checkbox", { name: "Catalog Beta 110", exact: true }),
  ).toBeFocused();
  await dialog
    .getByRole("button", { name: "Clear search", exact: true })
    .click();
  await expect(search).toBeFocused();
  await expect(dialog.getByRole("checkbox")).toHaveCount(120);
  await expect(first).not.toBeChecked();
  await expect(dialog.getByRole("status")).toHaveText("119 / 120 selected");
});

for (const theme of ["light", "dark"]) {
  test(`management fits narrow screens and supports keyboard: ${theme}`, async ({
    page,
  }, info) => {
    await openModels(page, true);
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    const trigger = page.getByRole("button", {
      name: "Select models: DeepSeek",
      exact: true,
    });
    await trigger.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", {
      name: "DeepSeek models",
      exact: true,
    });
    const checkbox = dialog.getByRole("checkbox", {
      name: "Catalog Alpha 0",
      exact: true,
    });
    await checkbox.focus();
    await page.keyboard.press("Space");
    await expect(checkbox).not.toBeChecked();
    await expect(checkbox).toBeFocused();
    await expect(dialog.getByRole("status")).toHaveText("119 / 120 selected");
    await page.keyboard.press("Tab");
    await expect(
      dialog.getByRole("checkbox", { name: "Catalog Alpha 1", exact: true }),
    ).toBeFocused();
    await checkbox.focus();
    await page.keyboard.press("Space");
    await expect(checkbox).toBeChecked();
    await expect(dialog.getByRole("status")).toHaveText("120 / 120 selected");
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 700 });
      await expect(
        dialog.getByRole("button", { name: "Save", exact: true }),
      ).toBeInViewport();
      const bounds = await dialog.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect(bounds!.width).toBeLessThanOrEqual(560);
      expect(
        await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
      const rowBounds = await dialog
        .locator(".settings-model-option")
        .first()
        .boundingBox();
      const searchBounds = await dialog
        .getByRole("textbox", { name: "Search models", exact: true })
        .boundingBox();
      expect(rowBounds!.y).toBeGreaterThan(
        searchBounds!.y + searchBounds!.height,
      );
      expect(rowBounds!.x + rowBounds!.width).toBeLessThanOrEqual(
        bounds!.x + bounds!.width,
      );
      await page.screenshot({
        path: info.outputPath(`manage-${theme}-${width}.png`),
      });
    }
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });
}
