import { test, expect } from "@playwright/test";
import { mockWorklens } from "./fixture.js";

for (const language of ["en", "zh"]) {
  test(`skill commands: filter enabled skills, keyboard selection and explicit invocation (${language})`, async ({
    page,
  }, info) => {
    await mockWorklens(page);
    await page.addInitScript((language) => {
      localStorage.setItem("worklens.language", language);
      const invoke = window.worklens.invoke;
      window.worklens.invoke = async (name, input) => {
        const result = await invoke(name, input);
        if (name === "skillsList") {
          result.local.push({
            id: "f".repeat(64),
            name: "manual-report",
            source: "local",
            enabled: true,
            disableModelInvocation: true,
            summary: "Write a report on request.",
            description: "Write a report on request.",
            path: "/local/manual-report/SKILL.md",
          });
        }
        return result;
      };
    }, language);
    await page.goto("/");
    const input = page.locator(".aui-composer-input");
    await input.fill("/");
    const menu = page.getByRole("listbox", {
      name: language === "en" ? "Skills" : "技能",
    });
    await expect(menu.getByRole("option")).toHaveCount(2);
    await expect(menu).toContainText("brave-search");
    await expect(menu).toContainText("manual-report");
    await expect(menu).not.toContainText("example-guide");
    await expect(menu).not.toContainText("pdf-tools");
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("option", { selected: true })).toContainText(
      "manual-report",
    );
    expect(
      await menu
        .getByRole("option", { selected: true })
        .evaluate((el) => getComputedStyle(el).backgroundColor),
    ).not.toBe(
      await menu
        .getByRole("option", { selected: false })
        .evaluate((el) => getComputedStyle(el).backgroundColor),
    );
    await page.keyboard.press("Enter");
    await expect(input).toHaveValue("/skill:manual-report ");
    await expect(menu).not.toBeVisible();
    expect(
      await page.evaluate(() => window.calls.filter((c) => c.name === "send")),
    ).toHaveLength(0);
    await input.fill("/brave");
    await expect(menu.getByRole("option")).toHaveCount(1);
    await page.keyboard.press("Tab");
    await expect(input).toHaveValue("/skill:brave-search ");
    await input.fill("/");
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).not.toBeVisible();
    await expect(input).toHaveValue("/");
    await input.fill("/skill:manual");
    await menu.getByRole("option").click();
    await expect(input).toHaveValue("/skill:manual-report ");
    // Screenshot the chooser at desktop and narrow widths.
    await input.fill("/");
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      if (width === 390) {
        await page.locator(".sidebar-toggle").click();
        await input.focus();
      }
      await expect(menu).toBeVisible();
      await page.screenshot({
        path: info.outputPath(`skill-commands-${language}-${width}.png`),
      });
      expect(
        await menu.evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
    }
    await input.fill("/skill:manual-report Write this week's report.");
    await page.keyboard.press("Enter");
    await expect
      .poll(() =>
        page.evaluate(
          () => window.calls.findLast((c) => c.name === "send")?.input.text,
        ),
      )
      .toBe("/skill:manual-report Write this week's report.");
  });
}

test("skill command chooser refreshes settings on reopening and ignores late results after dismissal", async ({
  page,
}) => {
  await mockWorklens(page);
  await page.addInitScript(() => {
    const invoke = window.worklens.invoke;
    window.worklens.invoke = async (name, input) => {
      if (name === "skillsList")
        await new Promise((resolve) => {
          window.releaseCommandSkills = resolve;
        });
      return invoke(name, input);
    };
  });
  await page.goto("/");
  const input = page.locator(".aui-composer-input");
  await input.fill("/");
  await expect(page.getByText("Loading skills…")).toBeVisible();
  await page.keyboard.press("Escape");
  await input.fill("ordinary message");
  await page.evaluate(() => window.releaseCommandSkills());
  await expect(
    page.getByRole("listbox", { name: "Skills" }),
  ).not.toBeVisible();
  await input.fill("/");
  await expect(page.getByText("Loading skills…")).toBeVisible();
  await page.evaluate(() => window.releaseCommandSkills());
  await expect(page.getByRole("option")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await page.evaluate(() =>
    window.worklens.invoke("skillsToggle", {
      id: "2".padStart(64, "0"),
      enabled: false,
    }),
  );
  await input.fill("/skill:");
  await expect(page.getByText("Loading skills…")).toBeVisible();
  await page.evaluate(() => window.releaseCommandSkills());
  await expect(page.getByRole("option")).toHaveCount(0);
  await expect(
    page.getByText("No matching enabled skills. Manage skills in Settings."),
  ).toBeVisible();
});
