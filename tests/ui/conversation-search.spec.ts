import { test, expect, type Page } from "@playwright/test";
import { mockWorklens } from "./fixture.js";

async function setup(page: Page) {
  await mockWorklens(page);
  await page.addInitScript(() => {
    const invoke = window.worklens.invoke;
    const turns = (id: string, title: string, match?: number) => ({
      id,
      title,
      phase: "completed",
      updatedAt: new Date().toISOString(),
      messages: Array.from({ length: 30 }, (_, i) => [
        {
          id: `${id}-user-${i}`,
          entryId: `${id}-entry-${i}`,
          role: "user",
          text:
            i === match
              ? "Does rubbing fingers mean anything?"
              : `Question ${i}`,
        },
        {
          id: `${id}-answer-${i}`,
          role: "assistant",
          text:
            i === match
              ? "Notably, **rubbing** fingers has no fixed meaning."
              : `Answer ${i}\n\n${"Filler paragraph. ".repeat(40)}`,
        },
      ]).flat(),
    });
    const views: Record<string, any> = {
      current: turns("current", "Current chat"),
      target: turns("target", "Body language", 3),
    };
    (window as any).searches = [];
    window.worklens.invoke = (async (name: string, input: any) => {
      if (name === "open") return structuredClone(views[input.id]);
      if (name === "searchConversations") {
        (window as any).searches.push(input.query);
        return input.query.toLowerCase().includes("rubbing")
          ? [
              {
                id: "target",
                title: "Body language",
                updatedAt: views.target.updatedAt,
                snippet: {
                  before: "Notably, **",
                  match: "rubbing** fingers",
                  after: " has no fixed meaning.",
                },
                messageId: "target-entry-3",
              },
            ]
          : [];
      }
      const result = await (invoke as any)(name, input);
      if (name === "bootstrap") {
        result.conversations = Object.values(views);
        result.settings.lastConversation = "current";
      }
      return result;
    }) as typeof window.worklens.invoke;
  });
  await page.goto("/");
  await expect(
    page.getByText("Answer 29", { exact: true }).first(),
  ).toBeVisible();
}

const highlighted = (page: Page) =>
  page.evaluate(() => {
    const highlight = CSS.highlights.get("worklens-search");
    const range = highlight && ([...highlight][0] as Range);
    if (!range) return undefined;
    const box = range.getBoundingClientRect();
    return {
      role: range.startContainer.parentElement
        ?.closest("[data-role]")
        ?.getAttribute("data-role"),
      text: range.toString(),
      visible: box.top >= 0 && box.bottom <= window.innerHeight,
    };
  });

test("searches conversations, opens a result and reveals the match", async ({
  page,
}) => {
  await setup(page);
  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.getByRole("dialog", { name: "Search conversations" });
  const input = dialog.getByRole("combobox", { name: "Search conversations" });
  await expect(input).toBeFocused();
  await expect(dialog.getByRole("option")).toHaveCount(2);
  await expect(input).toHaveAttribute("placeholder", "Search");
  // Placed as if centered at its full 530px height, then fits its results;
  // on tall windows the top stops at 25vh.
  const popup = (await dialog.boundingBox())!;
  const viewport = page.viewportSize()!;
  const full = Math.min(viewport.height - 64, 530);
  expect(
    Math.abs(popup.x + popup.width / 2 - viewport.width / 2),
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(
      popup.y - Math.min(viewport.height * 0.25, (viewport.height - full) / 2),
    ),
  ).toBeLessThanOrEqual(1);
  expect(popup.height).toBeLessThan(full);

  await input.fill("nothing");
  await expect(
    dialog.getByText(
      "No conversations match your search. Try different words.",
    ),
  ).toBeVisible();

  await input.fill("Rubbing fingers");
  const option = dialog.getByRole("option", { name: /Body language/ });
  await expect(option).toHaveAttribute("aria-selected", "true");
  await expect(option.locator("mark")).toHaveText("rubbing** fingers");
  await input.press("Enter");

  await expect(dialog).toBeHidden();
  await expect(page.locator('[data-slot="chat-title"]')).toHaveAttribute(
    "aria-label",
    "Body language",
  );
  // The reply match wins over the prompt, like the snippet; it spans bold
  // and plain text in the rendered Markdown.
  await expect
    .poll(() => highlighted(page))
    .toEqual({
      role: "assistant",
      text: "rubbing fingers",
      visible: true,
    });

  // Reopening keeps the query; Escape closes without navigating.
  await page.getByRole("button", { name: "Search conversations" }).click();
  await expect(input).toHaveValue("Rubbing fingers");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "Current chat", exact: true }).click();
  await expect.poll(() => highlighted(page)).toBeUndefined();
});

test("search button sits beside the sidebar toggle in both sidebar states", async ({
  page,
}) => {
  await setup(page);
  const search = page.getByRole("button", { name: "Search conversations" });
  const toggle = page.locator(".sidebar-toggle");
  const boxes = async () => ({
    search: (await search.boundingBox())!,
    toggle: (await toggle.boundingBox())!,
    title: (await page.locator('[data-slot="chat-title"]').boundingBox())!,
  });
  let box = await boxes();
  expect(box.search.y).toBe(box.toggle.y);
  expect(box.search.x + box.search.width).toBeLessThan(box.toggle.x);
  await toggle.click();
  await expect(page.locator("#conversation-sidebar")).toBeHidden();
  box = await boxes();
  expect(box.search.y).toBe(box.toggle.y);
  expect(box.search.x).toBeGreaterThan(box.toggle.x + box.toggle.width);
  expect(box.title.x).toBeGreaterThan(box.search.x + box.search.width);
  await search.click();
  await expect(
    page.getByRole("combobox", { name: "Search conversations" }),
  ).toBeFocused();
  const popup = (await page.getByRole("dialog").boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(
    Math.abs(popup.x + popup.width / 2 - viewport.width / 2),
  ).toBeLessThanOrEqual(1);
});
