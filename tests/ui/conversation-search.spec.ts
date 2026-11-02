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
    long.messages[19].text = String.raw`Cost $12 and $24. www.example.com（**今天** 很好） Formula $x^2$ and \(\frac{a}{b}\).`;
    // Text beside the indexed prompts and replies: thinking, a summary, a
    // code block's language and narration moved into the process disclosure.
    const mixed = {
      id: "mixed",
      title: "Mixed chat",
      phase: "completed",
      updatedAt: new Date().toISOString(),
      messages: [
        {
          id: "m-0",
          entryId: "mixed-entry-0",
          role: "user",
          text: "Is it ready?",
        },
        {
          id: "m-1",
          role: "assistant",
          thinking: "The copper kettle might be cold.",
          text: "Yes, the copper kettle is ready.",
        },
        {
          id: "m-2",
          entryId: "mixed-entry-1",
          role: "user",
          text: "Plan the walnut desk",
        },
        { id: "m-3", role: "assistant", text: "Sure." },
        { id: "m-4", role: "summary", text: "The user wants a walnut desk." },
        { id: "m-5", entryId: "mixed-entry-2", role: "user", text: "Run it?" },
        {
          id: "m-6",
          role: "assistant",
          text: "```python\nprint(1)\n```\n\nRun it with python.",
        },
        {
          id: "m-7",
          entryId: "mixed-entry-3",
          role: "user",
          text: "Check the pipes",
        },
        {
          id: "m-8",
          role: "assistant",
          text: "Checking the brass pipe first.",
        },
        {
          id: "m-9",
          role: "tool",
          toolId: "m-9",
          toolName: "bash",
          args: JSON.stringify({ command: "ls" }),
          text: "ok",
          status: "success",
        },
        { id: "m-10", role: "assistant", text: "All pipes are fine." },
        { id: "m-11", entryId: "mixed-entry-4", role: "user", text: "Same?" },
        {
          id: "m-12",
          role: "assistant",
          thinking: "The oak table is ready.",
          text: "The oak table is ready.",
        },
        {
          id: "m-13",
          entryId: "mixed-entry-5",
          role: "user",
          text: "/skill:maple-report Draft the summary",
        },
        { id: "m-14", role: "assistant", text: "Drafted." },
        {
          id: "m-15",
          entryId: "mixed-entry-6",
          role: "user",
          text: "/skill:quarterly-portfolio-review-and-forecast-assistant-for-the-northern-region-zucchini Go.",
        },
        { id: "m-16", role: "assistant", text: "Going." },
      ],
    };
    const views: Record<string, any> = {
      current: turns("current", "Current chat"),
      target: turns("target", "Body language", 3),
      long,
      mixed,
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
      copper: [result("mixed", "copper", "mixed-entry-0")],
      walnut: [result("mixed", "walnut", "mixed-entry-1")],
      python: [result("mixed", "python", "mixed-entry-2")],
      brass: [result("mixed", "brass", "mixed-entry-3")],
      oak: [result("mixed", "oak", "mixed-entry-4")],
      maple: [result("mixed", "maple-report Draft", "mixed-entry-5")],
      zucchini: [result("mixed", "zucchini", "mixed-entry-6")],
      zebra: [result("long", "zebra crossing", "long-entry-3")],
      violet: [result("long", "violet horizon", "long-entry-5")],
      alder: [result("long", "alder silver", "long-entry-6")],
      "x^2": [result("long", "x^2", "long-entry-9")],
      "\\frac{a}{b}": [result("long", "\\frac{a}{b}", "long-entry-9")],
      $12: [result("long", "$12", "long-entry-9")],
      "今天 很好": [result("long", "今天 很好", "long-entry-9")],
      longtitle: [
        {
          id: "longtitle",
          title: `A very long conversation title ${"that keeps going ".repeat(20)}`,
          updatedAt: views.current.updatedAt,
          snippet: { before: "…", match: "longtitle", after: "" },
          messageId: "longtitle-entry",
        },
      ],
      ...Object.fromEntries(
        [
          ["trio", 3],
          ["many", 6],
          ["lots", 30],
        ].map(([word, count]) => [
          word,
          Array.from({ length: count as number }, (_, i) => ({
            id: `${word}-${i}`,
            title: `${word} ${i}`,
            updatedAt: views.current.updatedAt,
            snippet: { before: "…", match: String(word), after: " in a reply" },
            messageId: `${word}-entry`,
          })),
        ]),
      ),
    };
    // A query whose search waits until the test releases it.
    const held: { query?: string; release?: () => void } = {};
    (window as any).holdSearch = (query: string) => {
      held.query = query;
      held.release = undefined;
    };
    // True while the held search waits to be released.
    (window as any).searchWaiting = () => !!held.release;
    (window as any).prepared = 0;
    (window as any).failSearch = false;
    (window as any).cancels = [];
    (window as any).skeletonSeen = false;
    new MutationObserver(() => {
      if (document.querySelector('[data-slot="search-skeleton"]'))
        (window as any).skeletonSeen = true;
    }).observe(document, { childList: true, subtree: true });
    // Releases the held search once it waits; true when it did.
    (window as any).releaseSearch = () => {
      const release = held.release;
      if (!release) return false;
      held.query = held.release = undefined;
      release();
      return true;
    };
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
        if ((window as any).failSearch)
          throw new Error("Synthetic search error");
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

// The text block holding the highlight.
const highlightedBlock = (page: Page) =>
  page.evaluate(() => {
    const highlight = CSS.highlights.get("worklens-search");
    const range = highlight && ([...highlight][0] as Range);
    const parent = range?.startContainer.parentElement;
    return parent?.closest("p, [data-search-text]")?.textContent ?? undefined;
  });

// Whether the highlight is inside a process disclosure, with the thinking.
const highlightInDisclosure = (page: Page) =>
  page.evaluate(() => {
    const highlight = CSS.highlights.get("worklens-search");
    const range = highlight && ([...highlight][0] as Range);
    const parent = range?.startContainer.parentElement;
    return parent
      ? !!parent.closest('[data-slot="reasoning-root"]')
      : undefined;
  });

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
  await expect(dialog.getByRole("option")).toHaveCount(4);
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

test("placeholders show as soon as the query changes and Enter waits for its results", async ({
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

  // Even a fast search shows placeholders until its results arrive.
  await input.fill("rubbing");
  await expect(
    dialog.getByRole("option", { name: /Body language/ }),
  ).toHaveAttribute("aria-selected", "true");
  expect(await page.evaluate(() => (window as any).skeletonSeen)).toBe(true);

  await page.evaluate(() => (window as any).holdSearch("zebra"));
  await input.fill("zebra");
  await input.press("Enter");
  await expect(dialog.getByRole("status")).toHaveText("Searching…");
  await expect(dialog.getByRole("option", { selected: true })).toHaveCount(0);
  // Placeholders replace the previous query's results at once.
  await expect(skeleton).toBeVisible();
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

test("the result area only grows while loading, then fits what arrives", async ({
  page,
}) => {
  await setup(page);
  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.getByRole("dialog", { name: "Search conversations" });
  const input = dialog.getByRole("combobox");
  const area = dialog.locator(".conversation-search-results");
  const skeleton = dialog.locator('[data-slot="search-skeleton"]');
  const options = dialog.getByRole("option");
  const empty = dialog.getByText(
    "No conversations match your search. Try different words.",
  );
  const height = async () => (await area.boundingBox())!.height;
  const top = (await dialog.boundingBox())!.y;
  const held = async (query: string) => {
    await page.evaluate((query) => (window as any).holdSearch(query), query);
    await input.fill(query);
    await expect(skeleton).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => (window as any).searchWaiting()))
      .toBe(true);
  };
  const release = () =>
    expect
      .poll(() => page.evaluate(() => (window as any).releaseSearch()))
      .toBe(true);
  // The area's vertical padding.
  const padding = await area.evaluate((element) => {
    const style = getComputedStyle(element);
    return parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  });
  const row = async () =>
    (await skeleton
      .locator(".conversation-search-option")
      .first()
      .boundingBox())!.height;

  // Loading from the recents keeps their height or grows to four rows.
  const recents = await height();
  await held("quiet meadow");
  const loading = Math.max(recents, 4 * (await row()) + padding);
  await expect.poll(height).toBeCloseTo(loading, 0);

  // No matches: it shrinks to the message, centered between the edges.
  await release();
  await expect(empty).toBeVisible();
  await expect.poll(height).toBeLessThan(loading);
  const gaps = await empty.evaluate((text) => {
    const box = text.getBoundingClientRect();
    const outer = text.closest(".conversation-search-results")!;
    const edges = outer.getBoundingClientRect();
    return [box.top - edges.top, edges.bottom - box.bottom];
  });
  expect(Math.abs(gaps[0] - gaps[1])).toBeLessThanOrEqual(1);

  // Loading from a shorter area grows to four rows; more results grow more.
  await held("many");
  await expect.poll(height).toBeCloseTo(4 * (await row()) + padding, 0);
  await release();
  await expect(options).toHaveCount(6);
  const six = await height();
  expect(six).toBeGreaterThan(4 * 50);

  // Loading never shrinks; one result then fits exactly, with no blank
  // space below and nothing to scroll.
  await held("rubbing");
  expect(await height()).toBe(six);
  await release();
  await expect(options).toHaveCount(1);
  const one = (await options.first().boundingBox())!.height;
  await expect.poll(height).toBeCloseTo(one + padding, 0);
  expect(
    await area.evaluate((element) => [
      getComputedStyle(element).overflowY,
      element.scrollHeight <= element.clientHeight,
    ]),
  ).toEqual(["hidden", true]);
  expect((await dialog.boundingBox())!.y).toBe(top);

  // The height eases only when motion is allowed.
  const transition = () =>
    area.evaluate((element) => getComputedStyle(element).transitionDuration);
  await expect.poll(transition).toBe("0s");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect.poll(transition).toBe("0.18s");
});

test("new content starts at the top, and only long lists scroll", async ({
  page,
}) => {
  await setup(page);
  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.getByRole("dialog", { name: "Search conversations" });
  const input = dialog.getByRole("combobox");
  const area = dialog.locator(".conversation-search-results");
  const skeleton = dialog.locator('[data-slot="search-skeleton"]');
  const options = dialog.getByRole("option");
  const scrolled = () => area.evaluate((element) => element.scrollTop);
  const toBottom = () =>
    area.evaluate((element) => (element.scrollTop = element.scrollHeight));

  await input.fill("lots");
  await expect(options).toHaveCount(30);
  expect(
    await area.evaluate((element) => getComputedStyle(element).overflowY),
  ).toBe("auto");
  await toBottom();
  expect(await scrolled()).toBeGreaterThan(0);

  // Placeholders for the next query start at the top, uncut.
  await page.evaluate(() => (window as any).holdSearch("many"));
  await input.fill("many");
  await expect(skeleton).toBeVisible();
  expect(await scrolled()).toBe(0);
  const first = (await skeleton
    .locator(".conversation-search-option")
    .first()
    .boundingBox())!;
  expect(first.y).toBeGreaterThanOrEqual((await area.boundingBox())!.y);
  // Its results start at the top too.
  await expect
    .poll(() => page.evaluate(() => (window as any).releaseSearch()))
    .toBe(true);
  await expect(options).toHaveCount(6);
  expect(await scrolled()).toBe(0);

  // Back from a scrolled list, the recents start at the top.
  await input.fill("lots");
  await expect(options).toHaveCount(30);
  await toBottom();
  await input.fill("");
  await expect(options).toHaveCount(4);
  expect(await scrolled()).toBe(0);
});

test("long titles truncate without a horizontal scrollbar, and the outline follows the theme", async ({
  page,
}) => {
  await setup(page);
  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.getByRole("dialog", { name: "Search conversations" });
  const area = dialog.locator(".conversation-search-results");
  await dialog.getByRole("combobox").fill("longtitle");
  const option = dialog.getByRole("option");
  await expect(option).toHaveCount(1);
  const title = option.locator(".truncate").first();
  expect(
    await title.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    ),
  ).toBe(true);
  expect(
    await area.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);

  // Light: no outline, the backdrop sets it apart. Dark: a faint edge.
  const shadow = () =>
    dialog.evaluate((element) => getComputedStyle(element).boxShadow);
  expect(await shadow()).toBe("none");
  await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
  await expect.poll(shadow).toContain("inset");
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

test("clearing or closing stops the pending search, and reopening shows its placeholders", async ({
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

  const waiting = () =>
    expect
      .poll(() => page.evaluate(() => (window as any).searchWaiting()))
      .toBe(true);

  // Clearing stops the search in progress but keeps the warm-up.
  await page.evaluate(() => (window as any).holdSearch("zebra"));
  await input.fill("zebra");
  await waiting();
  await input.fill("");
  await expect.poll(cancels).toEqual([{ warmUp: false }]);
  await release();

  // Closing while a search waits stops it and the warm-up.
  await page.evaluate(() => (window as any).holdSearch("violet"));
  await input.fill("violet");
  await waiting();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await cancels()).length).toBe(3);
  expect((await cancels()).slice(1)).toEqual(
    expect.arrayContaining([{ warmUp: false }, { warmUp: true }]),
  );

  // Reopening the same pending query shows its placeholders right away.
  await page.evaluate(() => (window as any).holdSearch("violet"));
  await page.keyboard.press("ControlOrMeta+k");
  await expect(input).toHaveValue("violet");
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

test("reopening and returning to the same query waits for fresh results", async ({
  page,
}) => {
  await setup(page);
  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.getByRole("dialog", { name: "Search conversations" });
  const input = dialog.getByRole("combobox");
  const skeleton = dialog.locator('[data-slot="search-skeleton"]');
  await input.fill("rubbing");
  await expect(dialog.getByRole("option")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.evaluate(() => (window as any).holdSearch("rubbing"));
  await page.keyboard.press("ControlOrMeta+k");
  await expect(skeleton).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => (window as any).searchWaiting()))
    .toBe(true);
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => (window as any).releaseSearch()))
    .toBe(true);
  await expect(skeleton).toHaveCount(0);
  await input.fill("other");
  await expect(skeleton).toBeVisible();
  await page.evaluate(() => (window as any).holdSearch("rubbing"));
  await input.fill("rubbing");
  await expect(skeleton).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => (window as any).releaseSearch()))
    .toBe(true);
  await expect(skeleton).toHaveCount(0);
});

test("retrying a failed query shows loading instead of its previous error", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => ((window as any).failSearch = true));
  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.getByRole("dialog", { name: "Search conversations" });
  await dialog.getByRole("combobox").fill("rubbing");
  await expect(dialog.getByRole("status")).toContainText("Couldn’t search");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.evaluate(() => {
    (window as any).failSearch = false;
    (window as any).holdSearch("rubbing");
  });
  await page.keyboard.press("ControlOrMeta+k");
  await expect(dialog.locator('[data-slot="search-skeleton"]')).toBeVisible();
  await expect(dialog.getByText(/Couldn’t search/)).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => (window as any).releaseSearch()))
    .toBe(true);
  await expect(dialog.getByRole("option")).toHaveCount(1);
});

for (const query of ["x^2", String.raw`\frac{a}{b}`]) {
  test(`reveals the whole formula for LaTeX source: ${query}`, async ({
    page,
  }) => {
    await setup(page);
    await page.keyboard.press("ControlOrMeta+k");
    const dialog = page.getByRole("dialog", { name: "Search conversations" });
    await dialog.getByRole("combobox").fill(query);
    await expect(dialog.getByRole("option")).toHaveCount(1);
    await page.keyboard.press("Enter");
    const formula = page.locator(".katex[data-search-match]");
    await expect(formula).toHaveCount(1);
    await expect(formula).toBeInViewport();
    await expect(
      formula.locator('annotation[encoding="application/x-tex"]'),
    ).toHaveText(query);
    await page.mouse.wheel(0, 30);
    await expect(formula).toHaveCount(1);
    await page.keyboard.press("ArrowDown");
    await expect(formula).toHaveCount(0);
    expect(
      await page.evaluate(() => CSS.highlights.has("worklens-search")),
    ).toBe(false);
  });
}

for (const query of ["$12", "今天 很好"]) {
  test(`reveals rendered Markdown text: ${query}`, async ({ page }) => {
    await setup(page);
    await page.keyboard.press("ControlOrMeta+k");
    const dialog = page.getByRole("dialog", { name: "Search conversations" });
    await dialog.getByRole("combobox").fill(query);
    await expect(dialog.getByRole("option")).toHaveCount(1);
    await page.keyboard.press("Enter");
    await expect
      .poll(() => highlighted(page))
      .toEqual({ role: "assistant", text: query, visible: true });
  });
}

test("reveals only the prompt and reply text the search indexes", async ({
  page,
}) => {
  await setup(page);
  const dialog = page.getByRole("dialog", { name: "Search conversations" });
  const open = async (query: string) => {
    await page.keyboard.press("ControlOrMeta+k");
    await dialog.getByRole("combobox").fill(query);
    await expect(
      dialog.getByRole("option", { name: /Mixed chat/ }),
    ).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
  };
  await page.getByRole("button", { name: "Mixed chat", exact: true }).click();
  await expect(
    page.getByText("Yes, the copper kettle is ready."),
  ).toBeVisible();

  // Expanded thinking with the same words comes first, but isn't indexed.
  const thoughts = page.getByRole("button", { name: "Thoughts" });
  await thoughts.first().click();
  await expect(
    page.getByText("The copper kettle might be cold."),
  ).toBeVisible();
  await open("copper");
  await expect
    .poll(() => highlightedBlock(page))
    .toBe("Yes, the copper kettle is ready.");

  // A summary after the reply isn't indexed: the snippet came from the prompt.
  await open("walnut");
  await expect
    .poll(() => highlighted(page))
    .toMatchObject({ role: "user", text: "walnut" });

  // A code block's language label isn't part of the reply text.
  await open("python");
  await expect.poll(() => highlightedBlock(page)).toBe("Run it with python.");

  // Narration moved into the process disclosure is indexed reply text: it is
  // revealed once the disclosure is expanded.
  await thoughts.nth(1).click();
  await expect(page.getByText("Checking the brass pipe first.")).toBeVisible();
  await open("brass");
  await expect
    .poll(() => highlightedBlock(page))
    .toBe("Checking the brass pipe first.");
  expect(await highlightInDisclosure(page)).toBe(true);

  // Thinking that reads exactly like the reply is still thinking.
  await thoughts.last().click();
  await expect(page.getByText("The oak table is ready.")).toHaveCount(2);
  await open("oak");
  await expect
    .poll(() => highlightedBlock(page))
    .toBe("The oak table is ready.");
  expect(await highlightInDisclosure(page)).toBe(false);

  // A skill call is indexed as shown: its tag's name, then the message.
  await open("maple-report draft");
  await expect
    .poll(() => highlighted(page))
    .toMatchObject({ role: "user", text: "maple-report Draft" });

  // A skill name cut short by its tag: a match in the hidden part marks the
  // whole tag.
  await page.setViewportSize({ width: 850, height: 720 });
  const tag = page
    .locator('[data-slot="skill-command-tag"]')
    .filter({ hasText: "quarterly" });
  expect(
    await tag
      .locator("span")
      .last()
      .evaluate((name) => name.scrollWidth > name.clientWidth),
  ).toBe(true);
  await open("zucchini");
  await expect(tag).toHaveAttribute("data-search-match", "");
  await expect
    .poll(() => highlighted(page))
    .toMatchObject({
      role: "user",
      text: "quarterly-portfolio-review-and-forecast-assistant-for-the-northern-region-zucchini",
    });
  await page.keyboard.press("Escape");
  await expect(tag).not.toHaveAttribute("data-search-match", "");
});
