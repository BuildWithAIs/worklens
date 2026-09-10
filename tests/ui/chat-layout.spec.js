import { test, expect } from "@playwright/test";
import { mockWorklens } from "./fixture.js";

test("compact tool activity, history actions and fluid message width", async ({
  page,
}, testInfo) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await mockWorklens(page);
  await page.addInitScript(() => {
    const invoke = window.worklens.invoke;
    const view = {
      id: "layout",
      title: "Review project files",
      phase: "completed",
      updatedAt: new Date().toISOString(),
      selection: { provider: "deepseek", model: "flash", thinking: "medium" },
      messages: [
        { id: "u1", role: "user", text: "Review project files." },
        ...Array.from({ length: 5 }, (_, i) => [
          {
            id: `reason${i}`,
            role: "assistant",
            thinking: `Thinking step ${i}`,
            text: i === 2 ? "Checking another source." : "",
          },
          {
            id: `t${i}`,
            role: "tool",
            toolId: `call${i}`,
            toolName: "read",
            args: JSON.stringify({ path: `file-${i}.md` }),
            text: `Result ${i}`,
            status: "success",
            elapsed: 120,
          },
        ]).flat(),
        {
          id: "a1",
          role: "assistant",
          text: "## Review complete\n\nThe project contains five documents. Each has been reviewed.\n\n| File | Result |\n| --- | --- |\n| README.md | Clear setup steps |\n| Guide.md | Needs examples |\n\n### Next steps\n\n- Add an example.\n- Update the guide.",
        },
        { id: "u2", role: "user", text: "Check another file." },
        {
          id: "t6",
          role: "tool",
          toolName: "read",
          text: "File not found",
          status: "error",
        },
      ],
    };
    if (localStorage.getItem("fixture-running")) {
      view.phase = "tool";
      view.messages.at(-1).status = "running";
      view.messages.at(-1).text = "";
    }
    window.sourceMessages = view.messages;
    window.progressFixture = (finish = false) => {
      view.phase = finish ? "completed" : "generating";
      view.messages.at(-1).status = "success";
      if (finish) {
        view.messages.push({ id: "final-live", role: "assistant", text: "Final live answer." });
      } else {
        view.messages.push(
          { id: "progress-live", role: "assistant", text: "Checking the latest source." },
          { id: "tool-live", role: "tool", toolName: "read", toolId: "live", text: "", status: "running" },
        );
      }
      window.emitFixture({ conversationId: view.id, runId: "test-run", sequence: finish ? 3 : 2, type: "message_update", view: structuredClone(view) });
    };
    window.completeFixture = () => {
      view.phase = "completed";
      view.messages.at(-1).status = "success";
      window.emitFixture({
        conversationId: view.id,
        runId: "test-run",
        sequence: 1,
        type: "run_end",
        view: structuredClone(view),
      });
    };
    window.worklens.onChat = (listener) => {
      window.emitFixture = listener;
      return () => {};
    };
    window.worklens.invoke = async (name, input) => {
      if (name === "open") return structuredClone(view);
      const result = await invoke(name, input);
      if (name === "bootstrap") {
        result.conversations = [view];
        result.settings.lastConversation = view.id;
      }
      return result;
    };
  });
  await page.goto("/");
  await expect(page.locator(".chat-header")).not.toContainText("Workspace");
  await expect(page.locator(".chat-header")).not.toContainText("Completed");
  expect(
    await page
      .locator(".chat-header")
      .evaluate((el) => getComputedStyle(el).borderBottomWidth),
  ).toBe("1px");
  const groups = page.locator('[data-slot="reasoning-trigger"]');
  await expect(groups).toHaveCount(2);
  expect(errors).toEqual([]);
  await expect(groups.nth(0)).toHaveText("Thoughts");
  await expect(groups.nth(1)).toHaveText("Thoughts · 1 failed");
  await expect(page.locator('[data-slot="tool-fallback-root"]')).toHaveCount(0);
  await expect(page.getByText("Checking another source.", { exact: true })).toHaveCount(0);
  await groups.first().click();
  await expect(page.getByText("Checking another source.", { exact: true })).toBeVisible();
  await expect(page.locator('[data-slot="tool-fallback-root"]')).toHaveCount(5);
  await expect(
    page.getByText("Thinking step 0", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Thinking step 4", { exact: true }),
  ).toBeVisible();
  await page.locator('[data-slot="tool-fallback-trigger"]').first().click();
  await expect(
    page.locator('[data-slot="tool-fallback-result"]'),
  ).toContainText("Result 0");
  await page.locator('[data-slot="tool-fallback-trigger"]').first().click();
  await page.screenshot({
    path: testInfo.outputPath("thoughts-expanded.png"),
    animations: "disabled",
  });
  await groups.first().click();
  await expect(page.locator('[data-slot="tool-fallback-root"]')).toHaveCount(0);
  expect(await page.evaluate(() => window.sourceMessages.length)).toBe(14);
  await expect(
    page.locator('[data-slot="aui_assistant-message-footer"]'),
  ).toHaveCount(1);
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Keep this unsent draft");
  const chatScroll = await page
    .locator('[data-slot="aui_thread-viewport"]')
    .evaluate((el) => el.scrollTop);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Settings", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "Settings", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveValue("Keep this unsent draft");
  expect(
    await page
      .locator('[data-slot="aui_thread-viewport"]')
      .evaluate((el) => el.scrollTop),
  ).toBe(chatScroll);
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("");
  const history = page.getByRole("navigation", { name: "Conversations" });
  await expect(history).not.toContainText("flash");
  await expect(
    history.getByRole("button", { name: "Review project files", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await history
    .getByRole("button", { name: "Conversation options: Review project files" })
    .focus();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await expect(
    page.getByRole("dialog", { name: "Rename conversation" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.locator('[data-slot="aui_user-message-root"]').last().hover();
  await expect(page.locator(".aui-user-action-edit")).toHaveCount(1);
  await page
    .locator('[data-slot="aui_assistant-message-root"]')
    .filter({ hasText: "Review complete" })
    .hover();
  await expect(
    page
      .locator(".aui-assistant-action-bar-root button")
      .filter({ hasText: "Regenerate" }),
  ).toHaveCount(1);
  await expect(
    page.locator('[data-slot="reasoning-trigger-icon"]'),
  ).toHaveCount(0);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const response = page
    .locator('[data-slot="aui_assistant-message-root"]')
    .filter({ hasText: "Review complete" });
  await response.hover();
  await response.getByRole("button", { name: "Copy", exact: true }).click();
  await expect(
    response.getByRole("button", { name: "Copied", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    "Review complete",
  );
  await page.evaluate(async () => {
    await navigator.clipboard.writeText("clipboard fallback sentinel");
    navigator.clipboard.writeText = async () => {
      throw new Error("NotAllowedError");
    };
  });
  await response.getByRole("button", { name: "Copied", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    "Review complete",
  );
  const sidebarMetrics = await page.evaluate(() => ({
    height: document.querySelector(".new-chat").getBoundingClientRect().height,
    weight: getComputedStyle(document.querySelector(".conversation-title"))
      .fontWeight,
  }));
  expect(sidebarMetrics.height).toBeGreaterThanOrEqual(40);
  expect(sidebarMetrics.weight).toBe("400");
  const typography = await page.evaluate(() => {
    const size = (selector) =>
      getComputedStyle(document.querySelector(selector)).fontSize;
    return [size(".aui-md-p"), size(".aui-md-li"), size(".aui-md-td")];
  });
  expect(typography).toEqual(["16px", "16px", "16px"]);
  const widths = [];
  for (const width of [1000, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    widths.push(
      await page.evaluate(() => ({
        messages: document
          .querySelector('[data-slot="aui_message-group"]')
          .getBoundingClientRect().width,
        composer: document
          .querySelector(".aui-thread-viewport-footer")
          .getBoundingClientRect().width,
        overflow: document.documentElement.scrollWidth > innerWidth,
      })),
    );
    await page.screenshot({
      path: testInfo.outputPath(`chat-${width}.png`),
      animations: "disabled",
    });
  }
  expect(widths[1].messages).toBeGreaterThan(widths[0].messages);
  expect(widths[1].messages).toBeLessThan(1050);
  expect(widths.every((w) => Math.abs(w.composer - w.messages) < 1)).toBe(true);
  expect(widths.every((w) => !w.overflow)).toBe(true);
  await page.evaluate(() => localStorage.setItem("fixture-running", "true"));
  await page.reload();
  await expect(groups.nth(1)).toHaveText("Thinking…");
  await expect(groups.nth(1)).toHaveAttribute("aria-expanded", "false");
  await page.evaluate(() => window.progressFixture());
  await expect(groups.nth(1)).toHaveText("Thinking…");
  await expect(groups.nth(1)).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator('[data-slot="activity-progress"]')).toHaveText("Checking the latest source.");
  const progressBox = await page.locator('[data-slot="activity-progress"]').boundingBox();
  const triggerBox = await groups.nth(1).boundingBox();
  expect(progressBox.y).toBeGreaterThanOrEqual(triggerBox.y + triggerBox.height);
  await expect(page.locator('[data-slot="aui_assistant-message-indicator"]')).toHaveCount(0);
  await groups.nth(1).click();
  await expect(groups.nth(1)).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator('[data-slot="activity-progress"]')).toHaveCount(0);
  await expect(page.getByText("Checking the latest source.", { exact: true })).toBeVisible();
  await page.evaluate(() => window.progressFixture(true));
  await expect(groups.nth(1)).toHaveText(/Worked for \d+s/);
  await expect(groups.nth(1)).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("Final live answer.", { exact: true })).toBeVisible();
  await groups.nth(1).click();
  await expect(page.getByText("Checking the latest source.", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Final live answer.", { exact: true })).toBeVisible();
  await page.evaluate(() => {
    navigator.clipboard.writeText = async () => {
      throw Error("denied");
    };
    document.execCommand = () => false;
  });
  await response.hover();
  await response.getByRole("button", { name: "Copy", exact: true }).click();
  await expect(page.locator('[data-slot="toast-title"]')).toContainText(
    "Could not copy",
  );
  await expect(
    response.getByRole("button", { name: "Copied", exact: true }),
  ).toHaveCount(0);
});
