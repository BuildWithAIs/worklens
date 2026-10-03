import { test, expect, type Page } from "@playwright/test";
import { mockWorklens } from "./fixture.js";

async function setup(page: Page) {
  await mockWorklens(page);
  await page.addInitScript(() => {
    const invoke = window.worklens.invoke;
    const table = [
      "| Day | Temperature | Rain | Wind |",
      "| --- | --- | --- | --- |",
      ...Array.from(
        { length: 20 },
        (_, i) => `| Day ${i} | 20°C | None | Light |`,
      ),
    ].join("\n");
    const views: Record<string, any> = {};
    for (let n = 0; n < 6; n++) {
      const id = `chat-${n}`;
      views[id] = {
        id,
        title: `History ${n}`,
        phase: "completed",
        updatedAt: "2026-10-03T00:00:00Z",
        selection: { provider: "deepseek", model: "flash", thinking: "medium" },
        messages: Array.from({ length: n ? 24 : 1 }, (_, i) => [
          { id: `${id}-user-${i}`, role: "user", text: `Question ${n}/${i}` },
          {
            id: `${id}-answer-${i}`,
            role: "assistant",
            text: `## Answer ${n}/${i}\n\n${table}`,
          },
        ]).flat(),
      };
    }
    const probe = {
      held: [] as string[],
      failed: [] as string[],
      calls: [] as string[],
      release: {} as Record<string, () => void>,
      selectionMs: [] as number[],
      partialRenders: [] as number[],
      visiblePartialRenders: [] as number[],
    };
    (window as any).switchProbe = probe;
    document.addEventListener("click", (event) => {
      const button = (event.target as Element).closest(".conversation-open");
      if (!button) return;
      const label = button.getAttribute("aria-label");
      const start = performance.now();
      const frame = () => {
        if (
          document
            .querySelector('[data-slot="chat-title"]')
            ?.getAttribute("aria-label") === label
        )
          probe.selectionMs.push(performance.now() - start);
        else requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
    new MutationObserver(() => {
      const history = document.querySelector(
        '[data-slot="progressive-history"]',
      );
      if (history?.getAttribute("aria-busy") === "true") {
        probe.partialRenders.push(
          history.querySelectorAll(".aui-md table").length,
        );
        if (getComputedStyle(history).visibility !== "hidden")
          probe.visiblePartialRenders.push(
            history.querySelectorAll(".aui-md table").length,
          );
      }
    }).observe(document, { childList: true, subtree: true });
    window.worklens.invoke = (async (name: string, input: any) => {
      if (name === "open") {
        probe.calls.push(input.id);
        if (probe.held.includes(input.id))
          await new Promise<void>((resolve) => {
            probe.release[input.id] = resolve;
          });
        if (probe.failed.includes(input.id))
          throw new Error("Synthetic load failure");
        return structuredClone(views[input.id]);
      }
      const result = await (invoke as any)(name, input);
      if (name === "bootstrap") {
        result.conversations = Object.values(views);
        result.settings.lastConversation = "chat-0";
      }
      return result;
    }) as typeof window.worklens.invoke;
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Answer 0/0", exact: true }),
  ).toBeAttached();
}

test("selection and loading paint before history arrives; stale responses cannot replace a newer selection or draft", async ({
  page,
}, info) => {
  await setup(page);
  await page.evaluate(() => {
    (window as any).switchProbe.held = ["chat-1", "chat-2"];
  });
  for (const n of [1, 2]) {
    const button = page.getByRole("button", {
      name: `History ${n}`,
      exact: true,
    });
    await button.click();
    await expect(button).toHaveAttribute("aria-current", "page");
    await expect(page.locator('[data-slot="chat-title"]')).toHaveAttribute(
      "aria-label",
      `History ${n}`,
    );
    await expect(
      page.locator('[data-slot="conversation-loading"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-slot="thread-loading-indicator"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-slot="thread-loading-indicator"] svg'),
    ).toBeVisible();
    await expect(
      page.locator('[data-slot="thread-loading-indicator"] span'),
    ).toHaveClass("sr-only");
    await expect(page.locator(".aui-composer-input")).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(
          (id) => typeof (window as any).switchProbe.release[id],
          `chat-${n}`,
        ),
      )
      .toBe("function");
  }
  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await page.screenshot({ path: info.outputPath(`loading-${theme}.png`) });
  }
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await page.locator(".aui-composer-input").fill("Keep this unsent draft");
  await page.evaluate(async () => {
    const probe = (window as any).switchProbe;
    probe.failed = ["chat-2"];
    probe.release["chat-2"]();
    probe.release["chat-1"]();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  await expect(page.locator(".aui-composer-input")).toHaveValue(
    "Keep this unsent draft",
  );
  await expect(page.locator('[data-slot="chat-title"]')).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("failed history remains retryable on the selected conversation", async ({
  page,
}) => {
  await setup(page);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.evaluate(() => {
    (window as any).switchProbe.failed = ["chat-1"];
  });
  await page.getByRole("button", { name: "History 1", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Couldn’t load this conversation. Try again.",
  );
  await page.evaluate(() => {
    (window as any).switchProbe.failed = [];
  });
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Answer 1/23", exact: true }),
  ).toBeAttached();
  await expect(
    page.locator('[data-slot="progressive-history"]'),
  ).toHaveAttribute("aria-busy", "false");
  await expect(page.locator(".aui-md table")).toHaveCount(24);
});

test("repeated multi-session switching paints selection promptly and progressively renders all history", async ({
  page,
}, info) => {
  await setup(page);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  for (const n of [1, 2, 3, 4, 5, 1, 3, 2, 4, 5, 1]) {
    const button = page.getByRole("button", {
      name: `History ${n}`,
      exact: true,
    });
    await button.click();
    await expect(button).toHaveAttribute("aria-current", "page");
    await expect(page.locator('[data-slot="chat-title"]')).toHaveAttribute(
      "aria-label",
      `History ${n}`,
    );
  }
  await expect(
    page.locator('[data-slot="progressive-history"]'),
  ).toHaveAttribute("aria-busy", "false");
  await expect(page.locator(".aui-md table")).toHaveCount(24);
  await expect(
    page.getByRole("heading", { name: "Answer 1/0", exact: true }),
  ).toBeAttached();
  await expect(
    page.getByRole("heading", { name: "Answer 1/23", exact: true }),
  ).toBeAttached();
  const probe = await page.evaluate(() => (window as any).switchProbe);
  expect(
    probe.partialRenders.some((count: number) => count > 0 && count < 24),
  ).toBe(true);
  expect(probe.visiblePartialRenders).toEqual([]);
  await expect(
    page.locator('[data-slot="thread-loading-indicator"]'),
  ).toHaveCount(0);
  const positions = await page
    .locator('[data-slot="aui_thread-viewport"]')
    .evaluate(async (viewport) => {
      const values: number[] = [];
      for (let frame = 0; frame < 20; frame++) {
        await new Promise(requestAnimationFrame);
        values.push(viewport.scrollTop);
      }
      return values;
    });
  expect(Math.max(...positions) - Math.min(...positions)).toBeLessThan(2);
  expect(probe.selectionMs).toHaveLength(11);
  expect(Math.max(...probe.selectionMs)).toBeLessThan(500);
  expect(errors).toEqual([]);
  await info.attach("selection-to-paint-ms", {
    body: JSON.stringify(probe.selectionMs),
    contentType: "application/json",
  });
  await session.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  await page.screenshot({ path: info.outputPath("loaded-history.png") });
});
