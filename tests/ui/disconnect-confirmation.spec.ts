import { test, expect } from "@playwright/test";
import { mockWorklens } from "./fixture.js";

for (const theme of ["light", "dark"])
  for (const kind of ["provider", "connector"]) {
    test(`disconnect softens and blocks the ${kind} form and preserves its draft on cancel and failure (${theme})`, async ({
      page,
    }, info) => {
      await mockWorklens(page);
      await page.addInitScript(() => {
        const invoke = window.worklens.invoke;
        window.worklens.invoke = (async (name: any, input: any) => {
          if (name === "logout" || name === "jiraRemove") {
            await new Promise((resolve) => setTimeout(resolve, 600));
            throw new Error("Local test disconnect failure");
          }
          const result = await invoke(name, input);
          if (name === "bootstrap")
            (result as any).jira = {
              url: "https://jira.example.test",
              configured: true,
            };
          return result;
        }) as typeof invoke;
      });
      await page.goto("/");
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page
        .getByRole("button", {
          name: kind === "provider" ? "Providers" : "Connectors",
          exact: true,
        })
        .click();
      const name = kind === "provider" ? "DeepSeek" : "Jira";
      await page
        .getByRole("listitem")
        .filter({ hasText: name })
        .getByRole("button", {
          name: kind === "provider" ? "Manage" : "Manage Jira",
          exact: true,
        })
        .click();
      const form = page.locator(".settings-dialog").filter({
        has: page
          .locator('[data-slot="dialog-title"]')
          .filter({ hasText: new RegExp(`^${name}$`) }),
      });
      const field = form.locator('input[type="password"]').first();
      await field.fill("local-draft-placeholder");
      await form
        .getByRole("button", { name: "Disconnect", exact: true })
        .click();
      const confirmation = page.getByRole("dialog", {
        name: `Disconnect ${name}?`,
        exact: true,
      });
      await expect(confirmation).toBeVisible();
      await expect(page.locator(".settings-confirmation-overlay")).toHaveCount(
        0,
      );
      const shade = await form.evaluate((el) => {
        const style = getComputedStyle(el, "::after");
        return {
          position: style.position,
          inset: style.inset,
          background: style.backgroundColor,
        };
      });
      expect(shade.position).toBe("absolute");
      expect(shade.inset).toBe("0px");
      expect(shade.background).toBe("rgba(0, 0, 0, 0)");
      const formContent = form.locator(":scope > form");
      await expect(formContent).toHaveCSS("opacity", "0.45");
      const lowerSave = form.getByRole("button", {
        name: "Save",
        exact: true,
        includeHidden: true,
      });
      expect(
        await lowerSave.evaluate((el) => {
          const rect = el.getBoundingClientRect();
          return el.contains(
            document.elementFromPoint(
              rect.x + rect.width / 2,
              rect.y + rect.height / 2,
            ),
          );
        }),
      ).toBe(false);
      await expect(
        confirmation.getByRole("button", { name: "Cancel", exact: true }),
      ).toBeFocused();
      for (let i = 0; i < 5; i++) {
        await page.keyboard.press("Tab");
        await expect
          .poll(() =>
            confirmation.evaluate((el) => el.contains(document.activeElement)),
          )
          .toBe(true);
      }

      await expect(form).toHaveCSS("opacity", "1");
      await confirmation
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      await expect(form).toHaveCSS("opacity", "1");
      await expect(field).toHaveValue("local-draft-placeholder");
      await expect(formContent).toHaveCSS("opacity", "1");
      await expect(
        form.getByRole("button", { name: "Disconnect", exact: true }),
      ).toBeFocused();
      await form
        .getByRole("button", { name: "Disconnect", exact: true })
        .click();
      await confirmation
        .getByRole("button", { name: "Disconnect", exact: true })
        .click();
      await expect(
        confirmation.getByRole("button", {
          name: "Disconnecting…",
          exact: true,
        }),
      ).toBeDisabled();
      await expect(form).toHaveCSS("opacity", "1");
      await page.screenshot({
        path: info.outputPath(`disconnect-${kind}.png`),
      });
      await expect(
        confirmation.getByRole("button", { name: "Cancel", exact: true }),
      ).toBeEnabled();
      await expect(form).toHaveCSS("opacity", "1");
      await confirmation
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      await expect(form).toHaveCSS("opacity", "1");
      await expect(field).toHaveValue("local-draft-placeholder");
      await expect(
        form.getByRole("button", { name: "Disconnect", exact: true }),
      ).toBeFocused();
      if (kind === "provider") {
        const save = form.getByRole("button", { name: "Save", exact: true });
        await expect(save).toBeEnabled();
        await save.click();
        await expect(form).toBeHidden();
      }
    });
  }
