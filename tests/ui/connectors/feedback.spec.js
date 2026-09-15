import { test, expect } from "@playwright/test";
import { mockWorklens } from "../fixture.js";

async function open(page, name) {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .locator(".settings-navigation")
    .getByRole("button", { name: "Connectors", exact: true })
    .click();
  await page
    .getByRole("button", { name: `Connect ${name}`, exact: true })
    .click();
  return page.getByRole("dialog", { name, exact: true });
}
for (const [service, name] of [
  ["jira", "Jira"],
  ["confluence", "Confluence"],
  ["github", "GitHub"],
]) {
  test(`${name}: validation, loading, readable errors and saved token reuse`, async ({
    page,
  }, info) => {
    await mockWorklens(page);
    await page.addInitScript((service) => {
      const invoke = window.worklens.invoke;
      window.worklens.invoke = async (method, input) => {
        if (method === `${service}Test`) {
          await new Promise((resolve) => setTimeout(resolve, 400));
          if (window.failConnection)
            throw new Error(
              JSON.stringify([
                {
                  origin: "string",
                  code: "too_small",
                  minimum: 1,
                  path: ["url"],
                  message: "Too small: expected string to have >=1 characters",
                },
              ]),
            );
        }
        return invoke(method, input);
      };
    }, service);
    const dialog = await open(page, name);
    const url = dialog.locator(`#${service}-url`);
    const token = dialog.locator(`#${service}-token`);
    const testButton = dialog.getByRole("button", {
      name: "Test connection",
      exact: true,
    });
    const saveButton = dialog.getByRole("button", {
      name: "Save",
      exact: true,
    });
    await expect(testButton).toBeDisabled();
    await url.hover();
    await url.focus();
    await token.focus();
    await dialog.getByRole("heading", { name, exact: true }).click();
    await url.focus();
    await expect(url).toHaveAttribute("aria-invalid", "false");
    await expect(token).toHaveAttribute("aria-invalid", "false");
    await expect(dialog).not.toContainText("Enter Site address.");
    await expect(dialog).not.toContainText("Enter Token.");
    await url.fill("not-a-url");
    await token.fill("synthetic-token");
    await testButton.click();
    await expect(url).toBeFocused();
    await expect(url).toHaveAttribute("aria-invalid", "true");
    expect(
      await page.evaluate(
        (service) =>
          window.calls.filter((c) => c.name === `${service}Test`).length,
        service,
      ),
    ).toBe(0);
    await url.fill(`https://${service}.example.test`);
    await expect(token).toHaveValue("synthetic-token");
    await page.evaluate(() => {
      window.failConnection = true;
    });
    await testButton.click();
    await expect(
      dialog.getByRole("button", { name: "Testing…", exact: true }),
    ).toBeDisabled();
    await expect(saveButton).toBeDisabled();
    await expect(saveButton).toHaveText("Save");
    await expect(page.locator('[data-slot="toast-title"]')).toHaveCount(0);
    await expect(dialog.locator(`#${service}-url-error`)).toHaveText(
      "Site address is required.",
    );
    await expect(url).toBeFocused();
    await expect(dialog).not.toContainText("too_small");
    await expect(token).toHaveValue("synthetic-token");
    await page.screenshot({ path: info.outputPath("connection-error.png") });
    await page.evaluate(() => {
      window.failConnection = false;
    });
    await testButton.click();
    await expect(
      page
        .locator('[data-slot="toast-title"]')
        .filter({ hasText: `Connected to ${name}` }),
    ).toBeVisible();
    await expect(dialog).toBeVisible();
    await saveButton.click();
    await expect(dialog).not.toBeVisible();
    await page
      .getByRole("button", { name: `Manage ${name}`, exact: true })
      .click();
    await expect(token).toHaveValue("");
    await expect(testButton).toBeEnabled();
    await testButton.click();
    await expect(testButton).toBeEnabled();
    await url.fill(`https://other-${service}.example.test`);
    await expect(testButton).toBeDisabled();
    await expect(saveButton).toBeDisabled();
  });
}

test("Atlassian cloud requirements retain the Jira discovery exception", async ({
  page,
}) => {
  await mockWorklens(page);
  for (const [service, name] of [
    ["jira", "Jira"],
    ["confluence", "Confluence"],
  ]) {
    const dialog = await open(page, name);
    await dialog
      .locator(`#${service}-url`)
      .fill(`https://${service}.example.test`);
    await dialog.locator(`#${service}-deployment`).selectOption("cloud");
    await dialog.locator(`#${service}-email`).fill("user@example.test");
    await dialog.locator(`#${service}-token-type`).selectOption("scoped");
    await dialog.locator(`#${service}-token`).fill("synthetic-token");
    const button = dialog.getByRole("button", {
      name: "Test connection",
      exact: true,
    });
    if (service === "jira") await expect(button).toBeEnabled();
    else {
      await expect(button).toBeDisabled();
      await dialog.locator(`#${service}-cloud-id`).fill("cloud-fixture");
      await expect(button).toBeEnabled();
    }
    await button.click();
    await expect(
      page
        .locator('[data-slot="toast-title"]')
        .filter({ hasText: `Connected to ${name}` }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
  }
});
