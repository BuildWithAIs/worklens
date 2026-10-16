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
    const long = turns("long", "Long chat");
    // A collapsed prompt with the match past its cut, and a reply paragraph
    // much taller than the window with the match at its end.
    long.messages[6].text = `${"Background line.\n".repeat(60)}zebra crossing`;
    long.messages[11].text = `${"Lorem ipsum dolor sit amet. ".repeat(400)}violet horizon.`;
    // A table whose row reads "alder silver" across two cells, and a later,
    // visible reply with the words of the collapsed prompt.
    long.messages[13].text =
      "| Wood | Metal |\n| --- | --- |\n| alder | silver |";
    long.messages[17].text = "The zebra crossing is on the corner.";
    const views: Record<string, any> = {
      current: turns("current", "Current chat"),
      target: turns("target", "Body language", 3),
      long,
    };
    const result = (id: string, match: string, messageId: string) => ({
      id,
      title: views[id].title,
      updatedAt: views[id].updatedAt,
      snippet: { before: "…", match, after: "" },
      messageId,
    });
    const results: Record<string, unknown[]> = {
      rubbing: [result("target", "rubbing fingers", "target-entry-3")],
      zebra: [result("long", "zebra crossing", "long-entry-3")],
      violet: [result("long", "violet horizon", "long-entry-5")],
      alder: [result("long", "alder silver", "long-entry-6")],
    };
    // A query whose search waits until the test releases it.
    const held: { query?: string; release?: () => void } = {};
    (window as any).holdSearch = (query: string) => (held.query = query);
    // True once the held search was waiting and has been released.
    (window as any).prepared = 0;
    (window as any).cancels = [];
    (window as any).skeletonSeen = false;
    new MutationObserver(() => {
      if (document.querySelector('[data-slot="search-skeleton"]'))
        (window as any).skeletonSeen = true;
    }).observe(document, { childList: true, subtree: true });
    (window as any).releaseSearch = () => !!held.release?.() || !!held.release;
    window.worklens.invoke = (async (name: string, input: any) => {
      if (name === "open") return structuredClone(views[input.id]);
      if (name === "prepareSearch") {
        (window as any).prepared += 1;
        return;
      }
      if (name === "cancelSearch") {
        (window as any).cancels.push(input);
        return;
      }
      if (name === "searchConversations") {
        if (input.query === held.query)
          await new Promise<void>((resolve) => (held.release = resolve));
        const key = Object.keys(results).find((word) =>
          input.query.toLowerCase().startsWith(word),
        );
        return key ? results[key] : [];
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
  await expect(dialog.getByRole("option")).toHaveCount(3);
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
  await expect(option.locator("mark")).toHaveText("rubbing fingers");
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

test("a slow query shows placeholders and Enter waits for its results", async ({
  page,
}) => {
  await setup(page);
  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.getByRole("dialog", { name: "Search conversations" });
  const input = dialog.getByRole("combobox", { name: "Search conversations" });
  const skeleton = dialog.locator('[data-slot="search-skeleton"]');
  // Opening the dialog starts indexing ahead of the query.
  await expect
    .poll(() => page.evaluate(() => (window as any).prepared))
    .toBe(1);

  // A fast search never flashes placeholders.
  await input.fill("rubbing");
  await expect(
    dialog.getByRole("option", { name: /Body language/ }),
  ).toHaveAttribute("aria-selected", "true");
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => (window as any).skeletonSeen)).toBe(false);

  await page.evaluate(() => (window as any).holdSearch("zebra"));
  await input.fill("zebra");
  await input.press("Enter");
  await expect(dialog.getByRole("status")).toHaveText("Searching…");
  await expect(dialog.getByRole("option", { selected: true })).toHaveCount(0);
  // Once slow, placeholders replace the previous query's results.
  await expect(skeleton.locator(".conversation-search-option")).toHaveCount(3);
  await expect(dialog.getByRole("listbox")).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(page.locator('[data-slot="chat-title"]')).toHaveAttribute(
    "aria-label",
    "Current chat",
  );

  // The search starts after the input debounce; release it once it waits.
  await expect
    .poll(() => page.evaluate(() => (window as any).releaseSearch()))
    .toBe(true);
  await expect(skeleton).toHaveCount(0);
  await expect(dialog.getByRole("status")).toHaveCount(0);
  await expect(
    dialog.getByRole("option", { name: /Long chat/ }),
  ).toHaveAttribute("aria-selected", "true");
  await input.press("Enter");
  await expect(page.locator('[data-slot="chat-title"]')).toHaveAttribute(
    "aria-label",
    "Long chat",
  );
});

test("pending searches reserve the empty-state layout before placeholders appear", async ({
  page,
}) => {
  await setup(page);
  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.getByRole("dialog", { name: "Search conversations" });
  const input = dialog.getByRole("combobox");
  const results = dialog.getByRole("listbox").locator("..");
  const skeleton = dialog.locator('[data-slot="search-skeleton"]');
  const empty = dialog.getByText(
    "No conversations match your search. Try different words.",
  );
  await page.clock.install({ time: new Date("2031-01-01T00:00:00Z") });
  await page.clock.pauseAt(new Date("2031-01-01T00:00:01Z"));

  // The first query has no earlier results to keep the result area open.
  await input.fill("quiet meadow");
  const firstPending = (await results.boundingBox())!;
  const top = (await dialog.boundingBox())!.y;
  await expect(empty).not.toBeVisible();
  await expect(skeleton).toHaveCount(0);
  await expect(dialog.getByRole("status")).toHaveText("Searching…");
  await page.clock.runFor(150);
  await expect(empty).toBeVisible();
  const baseline = (await results.boundingBox())!;
  expect(firstPending.height).toBe(baseline.height);

  // An empty previous result must not collapse while the next query waits.
  await page.setViewportSize({ width: 390, height: 900 });
  const narrowBaseline = (await results.boundingBox())!.height;
  await page.evaluate(() => (window as any).holdSearch("slow meadow"));
  await input.fill("slow meadow");
  expect((await results.boundingBox())!.height).toBe(narrowBaseline);
  await expect(empty).not.toBeVisible();
  await page.clock.runFor(249);
  await expect(skeleton).toHaveCount(0);
  expect((await results.boundingBox())!.height).toBe(narrowBaseline);
  await page.clock.runFor(1);
  await expect(skeleton).toBeVisible();
  await expect(skeleton.locator(".conversation-search-option")).toHaveCount(3);
  await expect
    .poll(() => page.evaluate(() => (window as any).releaseSearch()))
    .toBe(true);
  await expect(empty).toBeVisible();
  await expect(skeleton).toHaveCount(0);
  expect((await results.boundingBox())!.height).toBe(narrowBaseline);
  expect((await dialog.boundingBox())!.y).toBe(top);
});

test("reveals a match deep in a long paragraph and falls back for a collapsed prompt", async ({
  page,
}) => {
  await setup(page);
  const open = async (query: string) => {
    await page.keyboard.press("ControlOrMeta+k");
    const dialog = page.getByRole("dialog", { name: "Search conversations" });
    await dialog.getByRole("combobox").fill(query);
    await expect(
      dialog.getByRole("option", { name: /Long chat/ }),
    ).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
  };

  // The match itself is centered, not the paragraph around it.
  await open("violet horizon");
  await expect
    .poll(() => highlighted(page))
    .toEqual({ role: "assistant", text: "violet horizon", visible: true });

  // A match past a collapsed prompt's cut is not visible, so the turn's
  // prompt is shown instead and nothing is highlighted, not even the same
  // words in a later turn.
  await open("zebra crossing");
  const prompt = page.locator('[data-message-id="long-entry-3"]');
  await expect(prompt).toBeInViewport();
  await expect.poll(() => highlighted(page)).toBeUndefined();
  await expect(prompt.getByRole("button", { name: "Show more" })).toBeVisible();
});

test("reveals a phrase that spans two table cells", async ({ page }) => {
  await setup(page);
  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.getByRole("dialog", { name: "Search conversations" });
  await dialog.getByRole("combobox").fill("alder silver");
  await expect(
    dialog.getByRole("option", { name: /Long chat/ }),
  ).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  // The range runs from one cell to the next, so its text has no space.
  await expect
    .poll(() => highlighted(page))
    .toEqual({ role: "assistant", text: "aldersilver", visible: true });
});

test("clearing or closing stops the pending search and reopening restarts the placeholder delay", async ({
  page,
}) => {
  await setup(page);
  const cancels = () => page.evaluate(() => (window as any).cancels);
  const release = () =>
    expect
      .poll(() => page.evaluate(() => (window as any).releaseSearch()))
      .toBe(true);
  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.getByRole("dialog", { name: "Search conversations" });
  const input = dialog.getByRole("combobox", { name: "Search conversations" });
  const skeleton = dialog.locator('[data-slot="search-skeleton"]');

  // Clearing stops the search in progress but keeps the warm-up.
  await page.evaluate(() => (window as any).holdSearch("zebra"));
  await input.fill("zebra");
  // Placeholders show only after the request went out.
  await expect(skeleton).toBeVisible();
  await input.fill("");
  await expect.poll(cancels).toEqual([{ warmUp: false }]);
  await release();

  // Closing while a search waits stops it and the warm-up.
  await page.evaluate(() => (window as any).holdSearch("violet"));
  await input.fill("violet");
  await expect(skeleton).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await cancels()).length).toBe(3);
  expect((await cancels()).slice(1)).toEqual(
    expect.arrayContaining([{ warmUp: false }, { warmUp: true }]),
  );

  // Reopening the same pending query waits again before placeholders.
  await page.keyboard.press("ControlOrMeta+k");
  await expect(input).toHaveValue("violet");
  await expect(skeleton).toHaveCount(0);
  await expect(skeleton).toBeVisible();
  await release();
  await expect(skeleton).toHaveCount(0);
});

test("the highlight stays while reading around and clears on the next key press or click", async ({
  page,
}) => {
  await setup(page);
  const dialog = page.getByRole("dialog", { name: "Search conversations" });
  const reveal = async () => {
    await page.keyboard.press("ControlOrMeta+k");
    await dialog.getByRole("combobox").fill("Rubbing fingers");
    await expect(
      dialog.getByRole("option", { name: /Body language/ }),
    ).toHaveAttribute("aria-selected", "true");
    // The Enter that opens the result must not clear the new highlight.
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    await expect.poll(() => highlighted(page)).toBeDefined();
  };

  await reveal();
  // Reading around the match keeps it.
  await page.mouse.move(700, 400);
  await page.mouse.wheel(0, 300);
  await page.keyboard.press("Shift");
  await page.waitForTimeout(150);
  expect(await highlighted(page)).toBeDefined();
  // The next key press clears it.
  await page.keyboard.press("a");
  await expect.poll(() => highlighted(page)).toBeUndefined();

  await reveal();
  await page.mouse.click(700, 300);
  await expect.poll(() => highlighted(page)).toBeUndefined();

  await reveal();
  await page.keyboard.press("Escape");
  await expect.poll(() => highlighted(page)).toBeUndefined();
});
