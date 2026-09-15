import { test, expect } from "@playwright/test";
import { mockWorklens } from "../fixture.js";
for (const [service, name] of [
  ["jira", "Jira"],
  ["confluence", "Confluence"],
  ["github", "GitHub"],
]) {
  test(`${name}: completes only bare site URLs on blur and reuses saved tokens`, async ({
    page,
  }) => {
    await mockWorklens(page);
    await page.goto("/");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .locator(".settings-navigation")
      .getByRole("button", { name: "Connectors", exact: true })
      .click();
    await page
      .getByRole("button", { name: `Connect ${name}`, exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name, exact: true });
    const url = dialog.locator(`#${service}-url`);
    const token = dialog.locator(`#${service}-token`);
    await token.fill("synthetic-token");
    await url.fill("abc");
    await expect(token).toHaveValue("synthetic-token");
    await expect(url).toHaveValue("abc");
    await dialog
      .getByRole("button", { name: "Test connection", exact: true })
      .click();
    await expect(url).toHaveAttribute("aria-invalid", "true");
    await expect(url).toBeFocused();
    expect(
      await page.evaluate(
        (service) =>
          window.calls.filter((c) => c.name === `${service}Test`).length,
        service,
      ),
    ).toBe(0);
    await url.fill("example.test");
    await expect(url).toHaveValue("example.test");
    await expect(token).toHaveValue("synthetic-token");
    await token.focus();
    await expect(url).toHaveValue("https://example.test");
    await expect(token).toHaveValue("synthetic-token");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await page
      .getByRole("button", { name: `Manage ${name}`, exact: true })
      .click();
    await url.fill("example.test");
    await token.focus();
    await expect(url).toHaveValue("https://example.test");
    await expect(token).toHaveValue("");
    await expect(
      dialog.getByRole("button", { name: "Test connection", exact: true }),
    ).toBeEnabled();
    await url.fill("http://example.test");
    await token.focus();
    await expect(url).toHaveValue("http://example.test");
    await expect(
      dialog.getByRole("button", { name: "Test connection", exact: true }),
    ).toBeDisabled();
    await url.fill("other.example.test");
    await token.focus();
    await expect(token).toHaveValue("");
    await expect(
      dialog.getByRole("button", { name: "Save", exact: true }),
    ).toBeDisabled();
    await token.fill("new-synthetic-token");
    await url.fill("third.example.test");
    await token.focus();
    await expect(token).toHaveValue("new-synthetic-token");
    await expect(
      dialog.getByRole("button", { name: "Save", exact: true }),
    ).toBeEnabled();
  });
}
