import { test, expect } from "@playwright/test";
import { mockWorklens } from "./fixture.js";
for (const theme of ["light", "dark"]) {
  test(`completed activity fades only hidden content (${theme})`, async ({
    page,
  }, info) => {
    await mockWorklens(page);
    await page.addInitScript((theme) => {
      localStorage.setItem("worklens.theme", theme);
      const invoke = window.worklens.invoke;
      const view = {
        id: "fade",
        title: "Activity",
        phase: "completed",
        updatedAt: new Date().toISOString(),
        messages: [
          { id: "u", role: "user", text: "Review" },
          {
            id: "a",
            role: "assistant",
            thinking: Array.from(
              { length: 30 },
              (_, i) =>
                `Paragraph ${i + 1}: Reviewing the provided sources and checking the details.`,
            ).join("\n\n"),
            text: "Review complete.",
            runElapsedMs: 20000,
          },
        ],
      };
      window.worklens.invoke = async (name, input) => {
        if (name === "open") return view;
        const result = await invoke(name, input);
        if (name === "bootstrap") {
          result.conversations = [view];
          result.settings.lastConversation = view.id;
        }
        return result;
      };
    }, theme);
    await page.goto("/");
    await page
      .locator('.worklens-activity-section [data-slot="reasoning-trigger"]')
      .click();
    const text = page.locator(
      '.worklens-activity-section [data-slot="reasoning-text"]',
    );
    await expect(text).toHaveAttribute("data-scroll-below", "true");
    await expect(text).toHaveAttribute("data-scroll-above", "false");
    expect(
      await text.evaluate((el) =>
        getComputedStyle(el).getPropertyValue("--activity-fade-bottom").trim(),
      ),
    ).toBe("24px");
    await page.screenshot({ path: info.outputPath("fade-top.png") });
    await text.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(text).toHaveAttribute("data-scroll-below", "false");
    await expect(text).toHaveAttribute("data-scroll-above", "true");
    expect(
      await text.evaluate((el) =>
        getComputedStyle(el).getPropertyValue("--activity-fade-bottom").trim(),
      ),
    ).toBe("0px");
    await page.screenshot({ path: info.outputPath("fade-bottom.png") });
  });
}
