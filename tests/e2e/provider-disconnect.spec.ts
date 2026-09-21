import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("API-key providers disconnect from Manage without waiting for the pending login", async () => {
  const directory = await mkdtemp(join(tmpdir(), "worklens-disconnect-e2e-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WORKLENS_TEST_ROOT: directory,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) {
    if (/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|GITHUB_TOKEN|GH_TOKEN)$/.test(key))
      delete env[key];
  }
  const launch = () =>
    electron.launch({
      args: ["."],
      cwd: resolve("."),
      env: env as Record<string, string>,
    });
  let app = await launch();
  const providers = [
    ["openrouter", "OpenRouter"],
    ["deepseek", "DeepSeek"],
    ["openai", "OpenAI"],
    ["anthropic", "Anthropic"],
  ];
  try {
    let page = await app.firstWindow();
    await expect(page.locator(".sidebar")).toBeVisible();
    await page.evaluate(() => localStorage.setItem("worklens.language", "en"));
    await page.reload();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Providers", exact: true }).click();
    for (const [id, name] of providers) {
      const row = page.getByRole("listitem").filter({
        has: page
          .locator('[data-slot="item-title"]')
          .filter({ hasText: new RegExp(`^${name}(?:$|${name} API key)`) }),
      });
      await row.getByRole("button", { name: "Connect", exact: true }).click();
      const form = page.getByRole("dialog", { name, exact: true });
      await form
        .locator("#auth-answer")
        .fill("isolated-placeholder-not-a-real-key");
      await form.getByRole("button", { name: "Save", exact: true }).click();
      await expect(form).toBeHidden();
      await row.getByRole("button", { name: "Manage", exact: true }).click();
      await form
        .locator("#auth-answer")
        .fill("unsaved-replacement-placeholder");
      await form
        .getByRole("button", { name: "Disconnect", exact: true })
        .click();
      const confirmation = page.getByRole("dialog", {
        name: `Disconnect ${name}?`,
        exact: true,
      });
      await confirmation
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      await expect(form.locator("#auth-answer")).toHaveValue(
        "unsaved-replacement-placeholder",
      );
      await expect(
        form.getByRole("button", { name: "Save", exact: true }),
      ).toBeEnabled();
      await form
        .getByRole("button", { name: "Disconnect", exact: true })
        .click();
      await confirmation
        .getByRole("button", { name: "Disconnect", exact: true })
        .click();
      await expect(confirmation).toBeHidden({ timeout: 5000 });
      await expect(form).toBeHidden();
      await expect(
        row.getByRole("button", { name: "Connect", exact: true }),
      ).toBeVisible();
      const provider = await page.evaluate(
        async (id) =>
          (await window.worklens.invoke("bootstrap", undefined)).providers.find(
            (p) => p.id === id,
          ),
        id,
      );
      expect(provider?.configured).toBe(false);
      expect(provider?.credentialType).toBeUndefined();
      await expect(
        page.getByRole("region", { name: "Notifications", exact: true }),
      ).not.toContainText(/cancelled|canceled|failed|timeout/i);
    }
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await expect(page.locator(".sidebar")).toBeVisible();
    const state = await page.evaluate(() =>
      window.worklens.invoke("bootstrap", undefined),
    );
    for (const [id] of providers) {
      const provider = state.providers.find((p) => p.id === id);
      expect(provider?.configured).toBe(false);
      expect(provider?.credentialType).toBeUndefined();
    }
  } finally {
    await app.close();
  }
});
