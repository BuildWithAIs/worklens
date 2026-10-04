import { test, expect, type Page } from "@playwright/test";
import { mockWorklens } from "./fixture.js";

async function setup(page: Page, turns = 24, plain = false) {
  await mockWorklens(page);
  await page.addInitScript(
    ({ turns, plain }) => {
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
          selection: {
            provider: "deepseek",
            model: "flash",
            thinking: "medium",
          },
          messages: Array.from({ length: n ? turns : 1 }, (_, i) => [
            { id: `${id}-user-${i}`, role: "user", text: `Question ${n}/${i}` },
            {
              id: `${id}-answer-${i}`,
              role: "assistant",
              text: plain
                ? `Answer ${n}/${i}`
                : `## Answer ${n}/${i}\n\n${table}`,
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
      let listener: Parameters<typeof window.worklens.onChat>[0] | undefined;
      window.worklens.onChat = (callback) => {
        listener = callback;
        return () => {
          listener = undefined;
        };
      };
      (window as any).completeReply = (id: string, runId: string) => {
        listener?.({
          conversationId: id,
          runId,
          type: "run_end",
          sequence: 1,
          view: { ...views[id], runId, revision: 1 },
        });
      };
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
          for (const provider of result.providers)
            for (const model of provider.models) model.image = true;
        }
        return result;
      }) as typeof window.worklens.invoke;
    },
    { turns, plain },
  );
  await page.goto("/");
  await expect(page.getByText("Answer 0/0", { exact: true })).toBeVisible();
  await expect(page.locator(".aui-composer-input")).toBeFocused();
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

test("short messages load without waiting one frame per turn and restore typing focus", async ({
  page,
}, info) => {
  await setup(page, 300, true);
  const startedAt = await page.evaluate(() => performance.now());
  await page.getByRole("button", { name: "History 1", exact: true }).click();
  await expect(page.locator(".aui-thread-root")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  const elapsedMs = await page.evaluate(
    (start) => performance.now() - start,
    startedAt,
  );
  expect(elapsedMs).toBeLessThan(2000);
  await expect(
    page.locator('[data-slot="aui_assistant-message-root"]'),
  ).toHaveCount(300);
  await expect(page.locator(".aui-composer-input")).toBeFocused();
  await info.attach("600-message-load-ms", {
    body: JSON.stringify({ elapsedMs }),
    contentType: "application/json",
  });
});

for (const origin of ["History 0", "New chat"])
  test(`failed navigation preserves text and image drafts from ${origin}`, async ({
    page,
  }) => {
    await setup(page);
    if (origin === "New chat")
      await page.getByRole("button", { name: origin, exact: true }).click();
    await page.locator(".aui-composer-input").fill("Keep my unsent draft");
    const chooser = page.waitForEvent("filechooser");
    await page.locator(".aui-composer-add-attachment").click();
    await (
      await chooser
    ).setFiles({
      name: "draft.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGNoCX0HRwzEcQDdEhxxGEJJKQAAAABJRU5ErkJggg==",
        "base64",
      ),
    });
    await expect(page.locator(".aui-composer-attachments img")).toHaveCount(1);
    await expect(page.locator(".aui-attachment-tile-uploading")).toHaveCount(0);
    await page.evaluate(() => {
      (window as any).switchProbe.failed = ["chat-1"];
    });
    await page.getByRole("button", { name: "History 1", exact: true }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await page.getByRole("button", { name: origin, exact: true }).click();
    await expect(page.locator(".aui-composer-input")).toHaveValue(
      "Keep my unsent draft",
    );
    await expect(page.locator(".aui-composer-attachments img")).toHaveCount(1);
    await expect(page.locator(".aui-composer-input")).toBeFocused();
  });

test("failed and abandoned loads stay unread until history becomes visible", async ({
  page,
}) => {
  await setup(page);
  const row = page.locator(".conversation-item").filter({
    has: page.getByRole("button", { name: "History 1", exact: true }),
  });
  await page.evaluate(() => {
    (window as any).completeReply("chat-1", "first-reply");
    (window as any).switchProbe.failed = ["chat-1"];
  });
  await expect(row.locator(".conversation-unread")).toHaveCount(1);
  await page.getByRole("button", { name: "History 1", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(row.locator(".conversation-unread")).toHaveCount(1);
  await page.evaluate(() => {
    const probe = (window as any).switchProbe;
    probe.failed = [];
    probe.held = ["chat-1"];
  });
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => typeof (window as any).switchProbe.release["chat-1"]),
    )
    .toBe("function");
  await page.evaluate(() => {
    (window as any).completeReply("chat-1", "second-reply");
  });
  await page.getByRole("button", { name: "History 0", exact: true }).click();
  await expect(page.locator(".aui-composer-input")).toBeFocused();
  await page.evaluate(() => {
    (window as any).switchProbe.release["chat-1"]();
  });
  await expect(row.locator(".conversation-unread")).toHaveCount(1);
  await page.evaluate(() => {
    (window as any).switchProbe.held = [];
  });
  await page.getByRole("button", { name: "History 1", exact: true }).click();
  await expect(page.locator(".aui-composer-input")).toBeFocused();
  await expect(row.locator(".conversation-unread")).toHaveCount(0);
});
