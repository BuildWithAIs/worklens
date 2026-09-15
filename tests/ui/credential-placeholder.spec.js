import { test, expect } from "@playwright/test";
import { mockWorklens } from "./fixture.js";

for (const saved of [false, true]) {
  test(`credential placeholders are consistent, saved=${saved}`, async ({
    page,
  }, info) => {
    await mockWorklens(page);
    await page.addInitScript((saved) => {
      const invoke = window.worklens.invoke;
      window.worklens.invoke = async (method, input) => {
        const result = await invoke(method, input);
        if (method === "bootstrap") {
          const provider = result.providers.find((p) => p.id === "deepseek");
          provider.configured = saved;
          if (!saved) {
            delete provider.credentialHint;
            delete provider.credentialType;
          }
          for (const service of ["jira", "confluence", "github"]) {
            result[service] = {
              configured: saved,
              url: saved ? "https://example.test" : "",
              deployment: "data-center",
              tokenType: "classic",
            };
          }
        }
        return result;
      };
    }, saved);
    await page.goto("/");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .locator(".settings-navigation")
      .getByRole("button", { name: "Providers", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Search providers", exact: true })
      .fill("DeepSeek");
    await page
      .getByRole("button", { name: saved ? "Manage" : "Connect", exact: true })
      .click();
    const key = page.locator("#auth-answer");
    await expect(key).toHaveAttribute(
      "placeholder",
      saved ? "••••••••" : "Enter API key",
    );
    await expect(key).toHaveValue("");
    await page.screenshot({ path: info.outputPath("provider.png") });
    await page.keyboard.press("Escape");
    await page
      .locator(".settings-navigation")
      .getByRole("button", { name: "Connectors", exact: true })
      .click();
    for (const [service, name] of [
      ["jira", "Jira"],
      ["confluence", "Confluence"],
      ["github", "GitHub"],
    ]) {
      await page
        .getByRole("button", {
          name: `${saved ? "Manage" : "Connect"} ${name}`,
          exact: true,
        })
        .click();
      const token = page.locator(`#${service}-token`);
      await expect(token).toHaveAttribute(
        "placeholder",
        saved ? "••••••••" : "Enter token",
      );
      await expect(token).toHaveValue("");
      await page.screenshot({ path: info.outputPath(`${service}.png`) });
      await page.keyboard.press("Escape");
    }
  });
}
