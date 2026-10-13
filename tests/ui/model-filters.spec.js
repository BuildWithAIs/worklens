import { test, expect } from "@playwright/test";
import { mockWorklens } from "./fixture.js";

test("models filter by capability and show the last connection test", async ({
  page,
}) => {
  await mockWorklens(page);
  await page.addInitScript(() => {
    const invoke = window.worklens.invoke;
    window.worklens.invoke = async (method, input) => {
      if (method === "test" && input.model === "pro")
        throw Error("Model connection unavailable");
      const result = await invoke(method, input);
      if (method === "bootstrap") {
        const gpt = result.providers[1].models[0];
        gpt.reasoning = false;
        gpt.image = true;
      }
      return result;
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Models", exact: true }).click();
  const groups = page.locator(".settings-model-groups");
  const rows = groups.locator(".settings-model-row");
  const filter = page.getByRole("combobox", {
    name: "Filter models",
    exact: true,
  });

  await filter.selectOption("vision");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("GPT-5");
  await expect(rows.first().locator(".settings-model-meta")).toHaveText(
    "128K · Vision",
  );
  await expect(groups.getByText("DeepSeek", { exact: true })).toHaveCount(0);

  await filter.selectOption("thinking");
  await expect(rows.filter({ hasText: "GPT-5" })).toHaveCount(0);
  await expect(rows.filter({ hasText: "DeepSeek V4 Flash" })).toHaveCount(1);

  // Provider names alone do not satisfy a capability filter.
  await filter.selectOption("vision");
  await page
    .getByRole("textbox", { name: "Search models", exact: true })
    .fill("DeepSeek");
  await expect(page.locator(".settings-empty")).toHaveText(
    "No models match your filters.",
  );

  await page
    .getByRole("textbox", { name: "Search models", exact: true })
    .fill("");
  await filter.selectOption("all");
  const flash = rows.filter({ hasText: "DeepSeek V4 Flash" });
  await flash
    .getByRole("button", {
      name: "Test connection: DeepSeek V4 Flash",
      exact: true,
    })
    .click();
  await expect(flash.locator(".settings-model-status")).toHaveAttribute(
    "data-state",
    "passed",
  );
  await expect(flash.locator(".settings-model-status")).toHaveText(/\d/);

  const pro = rows.filter({ hasText: "DeepSeek V4 Pro" });
  await pro
    .getByRole("button", {
      name: "Test connection: DeepSeek V4 Pro",
      exact: true,
    })
    .click();
  await expect(pro.locator(".settings-model-status")).toHaveAttribute(
    "data-state",
    "failed",
  );
  await expect(pro.locator(".settings-model-status")).toHaveText("Failed");
  await expect(flash.locator(".settings-model-status")).toHaveAttribute(
    "data-state",
    "passed",
  );
});

test("long model lists show the remaining count in a full-width row", async ({
  page,
}) => {
  await mockWorklens(page);
  await page.addInitScript(() => {
    const invoke = window.worklens.invoke;
    window.worklens.invoke = async (method, input) => {
      const result = await invoke(method, input);
      if (method === "bootstrap") {
        const provider = result.providers[0];
        const [model] = provider.models;
        provider.models = Array.from({ length: 120 }, (_, i) => ({
          ...model,
          id: "model-" + i,
          name: "Model " + i,
        }));
      }
      return result;
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Models", exact: true }).click();
  const list = page.locator(".settings-model-list").first();
  const more = list.getByRole("button", {
    name: "Show more models · 70 remaining",
    exact: true,
  });
  await expect(list.locator(".settings-model-row")).toHaveCount(50);
  // The hover fill must reach the card edges, not stop at a transparent border.
  await expect(more).toHaveCSS("border-left-width", "0px");
  await expect(more).toHaveCSS("border-right-width", "0px");
  await expect(more).toHaveCSS("border-bottom-width", "0px");
  const listBox = await list.boundingBox();
  const moreBox = await more.boundingBox();
  expect(moreBox.x - listBox.x).toBeCloseTo(1, 0);
  expect(listBox.x + listBox.width - moreBox.x - moreBox.width).toBeCloseTo(
    1,
    0,
  );

  await more.click();
  await expect(list.locator(".settings-model-row")).toHaveCount(100);
  await list
    .getByRole("button", {
      name: "Show more models · 20 remaining",
      exact: true,
    })
    .click();
  await expect(list.locator(".settings-model-row")).toHaveCount(120);
  await expect(list.locator(".settings-model-more")).toHaveCount(0);
});
