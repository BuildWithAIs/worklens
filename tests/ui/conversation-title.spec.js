import { test, expect } from "@playwright/test";
import { mockExistingConversation } from "./fixture.js";

for (const theme of ["light", "dark"]) {
  test(`title limits and concise deletion: ${theme}`, async ({ page }, info) => {
    await mockExistingConversation(page);
    await page.goto("/");
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.getByRole("button", { name: "Conversation options: Existing conversation", exact: true }).click();
    await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Rename conversation" });
    const input = dialog.getByRole("textbox", { name: "Conversation name" });
    await input.fill("中".repeat(61));
    await expect(input).toHaveValue("中".repeat(60));
    await expect(dialog.locator("#rename-count")).toHaveText("60/60");
    await input.fill("😀".repeat(61));
    await expect(input).toHaveValue("😀".repeat(60));
    await input.fill("   ");
    await expect(dialog.getByRole("button", { name: "Save name" })).toBeDisabled();
    await input.fill("New name");
    await dialog.getByRole("button", { name: "Save name" }).click();
    expect(await page.evaluate(() => window.calls.filter(call => call.name === "rename").at(-1))).toMatchObject({ input: { id: "existing", title: "New name" } });
    await page.getByRole("button", { name: "Conversation options: Existing conversation", exact: true }).click();
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
    const deletion = page.getByRole("dialog", { name: "Delete conversation?" });
    await expect(deletion).not.toContainText("Existing conversation");
    await expect(deletion).toContainText("This permanently deletes this conversation. This cannot be undone.");
    await page.screenshot({ path: info.outputPath(`delete-${theme}.png`) });
    await deletion.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(await page.evaluate(() => window.calls.filter(call => call.name === "delete"))).toHaveLength(0);
  });
}
