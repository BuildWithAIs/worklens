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
    const highlight = page.locator('[data-slot="skill-command-highlight"]');
    await input.fill("/skill:manual");
    await expect(highlight).toHaveCount(0);
    await menu.getByRole("option").click();
    await expect(input).toHaveValue("/skill:manual-report ");
    await expect(highlight).toContainText("manual-report");
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
    await page.screenshot({
      path: info.outputPath(`skill-command-draft-${language}.png`),
    });
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

test("sent skill commands show the skill as a tag before the message", async ({
  page,
}, info) => {
  await mockWorklens(page);
  await page.addInitScript(() => {
    const invoke = window.worklens.invoke;
    const view = {
      id: "skill-call",
      title: "Weekly report",
      phase: "completed",
      messages: [
        {
          id: "m-0",
          role: "user",
          text: "/skill:manual-report Write this week's report.\nKeep it short.",
        },
        { id: "m-1", role: "user", text: "/skill:manual-report" },
        { id: "m-2", role: "user", text: "Use /skill:manual-report later" },
      ],
      updatedAt: "2026-09-13T00:00:00Z",
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
  });
  await page.goto("/");
  const messages = page.locator(".aui-user-message-content");
  await expect(messages).toHaveCount(3);
  const tags = page.locator('[data-slot="skill-command-tag"]');
  await expect(tags).toHaveCount(2);
  await expect(messages.nth(0).locator(tags)).toHaveText("manual-report");
  await expect(messages.nth(0)).toHaveText(
    "manual-report Write this week's report.\nKeep it short.",
  );
  await expect(messages.nth(1)).toHaveText("manual-report");
  // Only a leading command is a skill call.
  await expect(messages.nth(2)).toHaveText("Use /skill:manual-report later");
  // The tag opens what the skill does, or says it is no longer available.
  await tags.first().click();
  await expect(page.getByRole("dialog")).toContainText(
    "This skill is disabled or no longer available.",
  );
  await messages.nth(0).screenshot({
    path: info.outputPath("skill-command-sent.png"),
  });
});

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
  await expect(page.getByRole("listbox", { name: "Skills" })).not.toBeVisible();
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

test("skill command chooser stays above the scroll-to-bottom button", async ({
  page,
}, info) => {
  await mockWorklens(page);
  await page.addInitScript(() => {
    const invoke = window.worklens.invoke;
    const messages = Array.from({ length: 30 }, (_, i) => [
      { id: `u${i}`, role: "user", text: `Question ${i}` },
      { id: `a${i}`, role: "assistant", text: `Answer ${i}\n\nMore detail.` },
    ]).flat();
    const view = {
      id: "long",
      title: "Long conversation",
      phase: "completed",
      messages,
      updatedAt: "2026-09-13T00:00:00Z",
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
  });
  await page.goto("/");
  await expect(page.getByText("Answer 29")).toBeVisible();
  await page.getByText("Answer 29").hover();
  await page.mouse.wheel(0, -1200);
  const scrollDown = page.locator(".aui-thread-scroll-to-bottom");
  await expect(scrollDown).toBeVisible();
  await page.locator(".aui-composer-input").fill("/");
  const menu = page.getByRole("listbox", { name: "Skills" });
  await expect(menu.getByRole("option")).toHaveCount(1);
  await page.screenshot({ path: info.outputPath("chooser-over-scroll.png") });
  // The button sits where the chooser opens; the chooser must cover it.
  const box = await scrollDown.boundingBox();
  expect(
    await page.evaluate(
      ({ x, y }) =>
        !!document.elementFromPoint(x, y)?.closest('[role="listbox"]'),
      { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    ),
  ).toBe(true);
});

test("long skill names stay on one line in the draft and the message", async ({
  page,
}) => {
  const name = "quarterly-portfolio-review-and-forecast-assistant";
  await mockWorklens(page);
  await page.addInitScript((name) => {
    const invoke = window.worklens.invoke;
    const view = {
      id: "long-name",
      title: "Review",
      phase: "completed",
      messages: [{ id: "m-0", role: "user", text: `/skill:${name} Go.` }],
      updatedAt: "2026-09-13T00:00:00Z",
    };
    window.worklens.invoke = async (method, input) => {
      if (method === "open") return view;
      const result = await invoke(method, input);
      if (method === "bootstrap") {
        result.conversations = [view];
        result.settings.lastConversation = view.id;
      }
      return result;
    };
  }, name);
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/");
  const tag = page.locator('[data-slot="skill-command-tag"]');
  await expect(tag).toBeVisible();
  // The tag cuts the name short; its details show the whole name.
  const message = await page.locator(".aui-user-message-content").boundingBox();
  const box = await tag.boundingBox();
  expect(box.height).toBeLessThanOrEqual(24);
  expect(box.x + box.width).toBeLessThanOrEqual(message.x + message.width);
  await expect(tag).toHaveAccessibleName(`About ${name}`);

  // A command wider than the draft wraps there, so it shows as typed.
  const input = page.locator(".aui-composer-input");
  const chip = page.locator('[data-slot="skill-command-chip"]');
  await input.fill(`/skill:${name} Go.`);
  await expect(chip).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(chip).toBeVisible();
  await input.fill("/skill:brave-search Go.");
  await expect(chip).toHaveText("brave-search");
});

test("the caret can't land inside a skill chip in the draft", async ({
  page,
}) => {
  await mockWorklens(page);
  await page.goto("/");
  const input = page.locator(".aui-composer-input");
  const chip = page.locator('[data-slot="skill-command-chip"]');
  const caret = () =>
    input.evaluate((el) => [el.selectionStart, el.selectionEnd]);
  const after = "/skill:brave-search ".length;
  await input.fill("/skill:brave-search Go.");
  await expect(chip).toBeVisible();
  // A click on the chip, Home and arrow keys all stop just past it.
  // The chip lets clicks through to the draft beneath it.
  const box = await chip.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(caret).toEqual([after, after]);
  await page.keyboard.press("End");
  await page.keyboard.press("Home");
  await expect.poll(caret).toEqual([after, after]);
  await page.keyboard.press("ArrowLeft");
  await expect.poll(caret).toEqual([after, after]);
  await page.keyboard.type("Now ");
  await expect(input).toHaveValue("/skill:brave-search Now Go.");
  await expect(chip).toHaveText("brave-search");
  // Selections still cover the command, so it can be cleared at once.
  await page.keyboard.press("ControlOrMeta+a");
  await expect.poll(caret).toEqual([0, "/skill:brave-search Now Go.".length]);
  // Backspace just past the chip turns it back into text.
  await input.fill("/skill:brave-search ");
  await page.keyboard.press("End");
  await page.keyboard.press("Backspace");
  await expect(input).toHaveValue("/skill:brave-search");
  await expect(chip).toHaveCount(0);
});
