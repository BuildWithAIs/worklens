import { test, expect } from "@playwright/test";
import { mockWorklens } from "../fixture.js";
for (const [service, name] of [
  ["jira", "Jira"],
  ["confluence", "Confluence"],
  ["github", "GitHub"],
]) {
  test(`${name}: opening saved connection does not replay historical error`, async ({
    page,
  }) => {
    await mockWorklens(page);
    await page.addInitScript(
      ({ service, name }) => {
        const invoke = window.worklens.invoke;
        window.worklens.invoke = async (method, input) => {
          const result = await invoke(method, input);
          if (method === "bootstrap")
            result[service] = {
              ...result[service],
              configured: false,
              url: "https://example.test",
              error: `${name} 网络请求失败或超时`,
            };
          return result;
        };
      },
      { service, name },
    );
    await page.goto("/");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .locator(".settings-navigation")
      .getByRole("button", { name: "Connectors", exact: true })
      .click();
    await page
      .getByRole("button", { name: `Connect ${name}`, exact: true })
      .click();
    await expect(page.getByRole("dialog", { name, exact: true })).toBeVisible();
    await expect(page.locator('[data-slot="toast-title"]')).toHaveCount(0);
  });
}
