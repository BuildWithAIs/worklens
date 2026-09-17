import { test, expect } from "@playwright/test";
import { mockWorklens } from "./fixture.js";

test("new chat composer stays in place while typing and clearing", async ({ page }, testInfo) => {
  await mockWorklens(page);
  await page.goto("/");
  await expect(page.locator('[data-slot="chat-title"]')).toHaveCount(0);
  await expect(page.locator(".usage-trigger")).toHaveCount(0);
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  const composer = page.locator('[data-slot="aui_composer-shell"]');
  const suggestions = page.locator(".aui-thread-welcome-suggestions");
  for (const width of [1000, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(suggestions).toHaveCount(0);
    const before = await composer.boundingBox();
    expect(before.width).toBeLessThanOrEqual(680);
    const viewport = await page.locator('[data-slot="aui_thread-viewport"]').boundingBox();
    expect(Math.abs(before.x + before.width / 2 - viewport.x - viewport.width / 2)).toBeLessThanOrEqual(6);
    await page.screenshot({ path: testInfo.outputPath(`home-${width}.png`) });
    await input.fill("地");
    await expect(suggestions).toHaveCount(0);
    const during = await composer.boundingBox();
    expect(Math.abs(during.y - before.y)).toBeLessThan(1);
    await input.fill("");
    await expect(suggestions).toHaveCount(0);
    const after = await composer.boundingBox();
    expect(Math.abs(after.y - before.y)).toBeLessThan(1);
  }
});

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
        { id: "u1", role: "user", text: Array.from({ length: 16 }, (_, i) => `Review project files, requirement ${i + 1}.`).join("\n") },
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
          createdAt: "2026-09-12T03:31:00Z",
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
      view.messages.at(-1).runStartedAt = new Date(Date.now() - 45000).toISOString();
      view.phase = "tool";
      view.messages.at(-1).status = "running";
      view.messages.at(-1).text = "";
    }
    window.sourceMessages = view.messages;
    window.progressFixture = (finish = false) => {
      view.phase = finish ? "completed" : "generating";
      view.messages.at(-1).status = "success";
      if (finish) {
        view.messages.find(m => m.id === "t6").runElapsedMs = 47000;
        view.messages.push({ id: "final-live", role: "assistant", text: "Final live answer." });
      } else {
        view.messages.push(
          { id: "progress-live", role: "assistant", text: "Checking the latest source." },
          { id: "tool-live", role: "tool", toolName: "bash", toolId: "live", args: JSON.stringify({ command: "rg --files src" }), text: "", status: "running" },
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
    window.finishToolFixture = () => {
      view.messages.at(-1).status = "success";
      window.emitFixture({ conversationId: view.id, runId: "test-run", sequence: 2.5, type: "message_update", view: structuredClone(view) });
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
  const longMessage = page.locator(".aui-user-message-content").first();
  for (const [theme, background, foreground] of [
    ["dark", "rgb(75, 48, 128)", "rgb(255, 255, 255)"],
    ["light", "rgb(238, 230, 255)", "rgb(53, 36, 85)"],
  ]) {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("combobox", { name: "Appearance", exact: true }).selectOption(theme);
    await page.getByRole("button", { name: "Back to app", exact: true }).click();
    for (const bubble of await page.locator(".aui-user-message-content").all()) {
      await expect(bubble).toHaveCSS("background-color", background);
      await expect(bubble).toHaveCSS("color", foreground);
    }
  }

  const expandMessage = longMessage.getByRole("button", { name: "Show more", exact: true });
  await expect(expandMessage).toHaveAttribute("aria-expanded", "false");
  const collapsedHeight = (await longMessage.boundingBox()).height;
  await expandMessage.click();
  const collapseMessage = longMessage.getByRole("button", { name: "Show less", exact: true });
  await expect(collapseMessage).toHaveAttribute("aria-expanded", "true");
  await expect(collapseMessage).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(collapseMessage).toHaveCSS("font-size", "14px");
  expect((await longMessage.boundingBox()).height).toBeGreaterThan(collapsedHeight);
  await collapseMessage.click();
  await expect(expandMessage).toBeVisible();
  await expect(page.locator(".aui-user-message-content").last().getByRole("button", { name: "Show more", exact: true })).toHaveCount(0);
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
  const toolGeometry = await page.locator('[data-slot="tool-fallback-trigger"]').first().evaluate(row => {
    const chevron = row.querySelector('[data-slot="tool-fallback-trigger-chevron"]').getBoundingClientRect();
    const duration = (row.querySelector('[data-slot="tool-fallback-duration"]') ?? row.querySelector('[data-slot="tool-fallback-trigger-label"]')).getBoundingClientRect();
    return { arrowGap: chevron.left - duration.right, height: row.getBoundingClientRect().height };
  });
  expect(toolGeometry.arrowGap).toBeCloseTo(8, 0);
  expect(toolGeometry.height).toBe(32);
  await page.locator('[data-slot="tool-fallback-trigger"]').first().click();
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const argsBlock = page.locator('[data-slot="tool-fallback-args"]').first();
  await argsBlock.getByRole("button", { name: "Copy", exact: true }).click();
  await expect(argsBlock.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(JSON.stringify({ path: "file-0.md" }, null, 2));
  const resultBlock = page.locator('[data-slot="tool-fallback-result"]').first();
  await resultBlock.getByRole("button", { name: "Copy", exact: true }).click();
  await expect(resultBlock.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await resultBlock.locator("pre").innerText());
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
  await history.getByRole("button", { name: "Conversation options: Review project files" }).click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  const deletion = page.getByRole("dialog", { name: "Delete conversation?" });
  await expect(deletion).toBeVisible();
  await expect(deletion.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await expect(deletion).toContainText("This permanently deletes this conversation. This cannot be undone.");
  expect((await deletion.boundingBox()).width).toBeLessThanOrEqual(440);
  await page.screenshot({ path: testInfo.outputPath("delete-confirmation.png"), animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(deletion).toBeHidden();
  await expect(history.getByRole("button", { name: "Review project files", exact: true })).toBeVisible();
  await page.locator('[data-slot="aui_user-message-root"]').last().hover();
  const user = page.locator('[data-slot="aui_user-message-root"]').last();
  const actions = user.locator(".aui-user-action-bar-wrapper");
  await expect(actions).toHaveCSS("opacity", "1");
  await user.getByRole("button", { name: "Copy", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("Check another file.");
  await user.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("Check another file.");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("");
  await page.locator(".chat-header").click();
  await expect(actions).toHaveCSS("opacity", "0");
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
  const reply = page.locator('[data-slot="aui_assistant-message-root"]').filter({ hasText: "Review complete" });
  await reply.hover();
  await expect(reply.locator("time")).toHaveAttribute("datetime", "2026-09-12T03:31:00.000Z");
  await expect(reply.locator("time")).toHaveCSS("opacity", "1");
  await page.locator(".chat-header").click();
  await expect.poll(() => reply.locator("time").evaluateAll(nodes => nodes.every(node => getComputedStyle(node).opacity === "0"))).toBe(true);
  await expect(reply.locator(".aui-md-h2")).toHaveCSS("font-size", "15px");
  await expect(page.locator('[data-slot="chat-title"]')).toHaveCSS("font-size", "15px");
  await expect(page.locator('[data-slot="chat-title"]')).toHaveCSS("font-weight", "500");
  const typography = await page.evaluate(() => {
    const size = (selector) =>
      getComputedStyle(document.querySelector(selector)).fontSize;
    return [size(".aui-md-p"), size(".aui-md-li"), size(".aui-md-td")];
  });
  expect(typography).toEqual(["14px", "14px", "14px"]);
  const widths = [];
  for (const width of [1000, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    widths.push(
      await page.evaluate(() => ({
        userBubble: document.querySelector(".aui-user-message-content").getBoundingClientRect().width,
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
  expect(widths.every(w => w.userBubble <= w.messages * 0.75)).toBe(true);
  expect(widths[1].messages).toBeGreaterThan(widths[0].messages);
  expect(widths[1].messages).toBeLessThanOrEqual(800);
  expect(widths.every((w) => Math.abs(w.composer - w.messages) < 1)).toBe(true);
  expect(widths.every((w) => !w.overflow)).toBe(true);
  await page.evaluate(() => localStorage.setItem("fixture-running", "true"));
  await page.reload();
  await expect(groups.nth(1)).toHaveText(/Working for 4[5-9]s/);
  await expect(page.locator('.worklens-activity-section').nth(1)).toHaveCSS("border-bottom-width", "0px");
  await page.getByRole("button", { name: "New chat", exact: false }).click();
  await page.locator(".conversation-open").first().click();
  await expect(groups.nth(1)).toHaveText(/Working for 4[5-9]s/);
  await expect(page.locator(".chat-header .run-status")).toHaveCount(0);
  await expect(page.locator('[data-slot="activity-progress"]').last()).toContainText("Reading");
  await expect(groups.nth(1)).toHaveText(/Working for [1-9]\d*s/);
  await expect(groups.nth(1)).toHaveAttribute("aria-expanded", "true");
  await page.evaluate(() => window.progressFixture());
  await expect(groups.nth(1)).toHaveText(/Working for \d+s/);
  await expect(groups.nth(1)).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator('[data-slot="activity-progress"]').last()).toContainText("Running bash · rg --files src");
  const toolRow = page.locator('[data-slot="activity-progress"]').last();
  await expect(toolRow.locator(".lucide-square-terminal")).toHaveCount(1);
  await expect(toolRow.locator("span")).toHaveCSS("white-space", "nowrap");
  await expect(page.getByText("Checking the latest source.", { exact: true })).toBeVisible();
  await expect(page.locator('[data-slot="aui_assistant-message-indicator"]')).toHaveCount(0);
  await page.evaluate(() => window.finishToolFixture());
  await expect(toolRow).toContainText("Ran command");
  await expect(page.locator('[data-slot="activity-progress"]').last()).toContainText("Ran command");
  await expect(groups.nth(1)).toHaveText(/Working for/);
  await expect(groups.nth(1)).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("Checking the latest source.", { exact: true })).toBeVisible();
  await page.evaluate(() => window.progressFixture(true));
  await expect(groups.nth(1)).toHaveText("Worked for 47s");
  await expect(groups.nth(1)).toHaveAttribute("aria-expanded", "false");
  await groups.nth(1).click();
  await expect(page.locator('.worklens-activity-section').nth(1)).toHaveCSS("border-bottom-width", "1px");
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
