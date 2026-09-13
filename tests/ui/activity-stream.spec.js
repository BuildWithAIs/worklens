import { test, expect } from "@playwright/test";
import { mockWorklens } from "./fixture.js";

async function setup(page, thinkingOnly = false) {
  await mockWorklens(page);
  await page.addInitScript((thinkingOnly) => {
    const invoke = window.worklens.invoke;
    let sequence = 0;
    const view = {
      id: "stream",
      title: "Activity stream",
      phase: "generating",
      updatedAt: new Date().toISOString(),
      selection: { provider: "deepseek", model: "flash", thinking: "medium" },
      messages: [
        { id: "user", role: "user", text: "Review the files" },
        {
          id: "first",
          role: "assistant",
          text: thinkingOnly ? "" : "I will check the files first.",
          thinking: thinkingOnly
            ? "Raw reasoning detail. ".repeat(400)
            : undefined,
          runStartedAt: new Date(Date.now() - 12000).toISOString(),
        },
      ],
    };
    if (thinkingOnly === "empty") view.messages.pop();
    window.worklens.onChat = (listener) => {
      window.deliver = listener;
      return () => {};
    };
    window.updateActivity = ({
      messages = [],
      phase = "generating",
      finishTool = false,
      patch,
    }) => {
      if (finishTool)
        for (const message of view.messages)
          if (message.role === "tool") message.status = "success";
      if (patch) Object.assign(view.messages.find(message => message.id === patch.id), patch);
    view.messages.push(...messages);
      view.phase = phase;
      window.deliver({
        conversationId: view.id,
        runId: "stream",
        sequence: ++sequence,
        type: "message_update",
        view: structuredClone(view),
      });
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
  }, thinkingOnly);
  await page.goto("/");
}

for (const theme of ["light", "dark"]) {
  test(`only the latest activity is visible: ${theme}`, async ({
    page,
  }, testInfo) => {
    await setup(page, true);
    await page.evaluate(
      (theme) => (document.documentElement.dataset.theme = theme),
      theme,
    );
    const root = page.locator(".worklens-activity-section");
    const row = root.locator('[data-slot="activity-progress"]');
    await expect(row).toHaveText("Thinking");
    await expect(row.locator("svg")).toHaveCount(0);
    await expect(root.locator(".lucide-brain")).toHaveCount(0);
    await expect(root).not.toContainText("Raw reasoning detail.");
    await expect(root.locator('[data-slot="reasoning-trigger-label"]')).not.toHaveClass(/shimmer/);
    const height = (await root.boundingBox()).height;
    await row.evaluate((node) => (window.activityNode = node));
    for (let i = 0; i < 12; i++) {
      await page.evaluate(
        (i) =>
          window.updateActivity({
            phase: "tool",
            messages: [
              {
                id: `search-${i}`,
                role: "tool",
                toolName: "web_search",
                text: "",
                args: JSON.stringify({ query: `query-${i}` }),
                status: "running",
              },
            ],
          }),
        i,
      );
      await expect(row).toHaveText(`Searching · query-${i}`);
      await row.locator("span").hover();
      await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText(`Searching · query-${i}`);
      await page.mouse.move(0, 0);
      await expect(root.locator('[data-slot="activity-progress"]')).toHaveCount(
        1,
      );
      await expect(
        root.locator('[data-slot="tool-fallback-trigger"]'),
      ).toHaveCount(0);
      expect(await row.evaluate((node) => node === window.activityNode)).toBe(
        true,
      );
      expect((await root.boundingBox()).height).toBe(height);
    }
    await expect(row.locator(".lucide-globe")).toHaveCount(1);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(row.locator(".shimmer")).not.toHaveCSS(
      "animation-name",
      "none",
    );
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(row.locator(".shimmer")).toHaveCSS("animation-name", "none");
    await page.evaluate(() =>
      window.updateActivity({
        finishTool: true,
        messages: [
          {
            id: "reasoning",
            role: "assistant",
            text: "",
            thinking: "More raw thought. ".repeat(500),
          },
        ],
      }),
    );
    await expect(row).toHaveText("Thinking");
    await expect(root).not.toContainText("query-");
    await expect(root).not.toContainText("More raw thought.");
    expect((await root.boundingBox()).height).toBe(height);
    await page.evaluate(() =>
      window.updateActivity({
        phase: "tool",
        messages: [
          {
            id: "bash",
            role: "tool",
            toolName: "bash",
            text: "",
            status: "running",
            args: JSON.stringify({
              command: "rg --files " + "long-path/".repeat(100),
            }),
          },
        ],
      }),
    );
    await expect(row.locator(".lucide-square-terminal")).toHaveCount(1);
    await expect(row.locator("span")).toHaveCSS("white-space", "nowrap");
    await expect(row).toHaveText("Running bash · rg --files " + "long-path/".repeat(100));
    await row.locator("span").hover();
    await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText("Running bash · rg --files " + "long-path/".repeat(100));
    await page.mouse.move(0, 0);
    await expect(row.locator("span")).toHaveCSS("text-overflow", "ellipsis");
    const text = row.locator("span");
    expect(await text.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
    const widthBefore = (await text.boundingBox()).width;
    await page.setViewportSize({ width: 850, height: 900 });
    expect((await text.boundingBox()).width).toBeLessThan(widthBefore);
    await expect(row.locator("span")).toHaveCSS("white-space", "nowrap");
    await page.setViewportSize({ width: 1280, height: 900 });
    expect((await root.boundingBox()).height).toBe(height);
    await page.screenshot({
      path: testInfo.outputPath(`latest-activity-${theme}.png`),
    });
    await page.evaluate(() =>
      window.updateActivity({
        phase: "completed",
        finishTool: true,
        messages: [
          {
            id: "final",
            role: "assistant",
            text: "Final answer remains visible.",
          },
        ],
      }),
    );
    await expect(row).toHaveCount(0);
    await expect(
      page.getByText("Final answer remains visible.", { exact: true }),
    ).toBeVisible();
    const heading = root.locator('[data-slot="reasoning-trigger"]');
    await expect(heading).toHaveAttribute("aria-expanded", "false");
    await heading.click();
    await expect(
      root.locator('[data-slot="tool-fallback-trigger"]'),
    ).toHaveCount(13);
    await root.locator('[data-slot="tool-fallback-trigger"]').first().click();
    await expect(root).toContainText("query-0");
    await root.locator('[data-slot="tool-fallback-trigger"]').nth(11).click();
    await expect(root).toContainText("query-11");
  });
}

test("latest status covers special phases, unknown tools and cancelled answers", async ({
  page,
}) => {
  await setup(page);
  const row = page.locator('[data-slot="activity-progress"]');
  await expect(row).toHaveCount(0);
  await expect(page.getByText("I will check the files first.", { exact: true })).toBeVisible();
  await expect(row.locator("svg")).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(page.locator('[data-slot="reasoning-trigger-label"]')).toHaveCSS("animation-name", "none");
  for (const [phase, icon, label] of [
    ["compacting", "scan-text", "Compacting context"],
    ["retrying", "rotate-cw", "Retrying"],
    ["stopping", "circle-stop", "Stopping"],
  ]) {
    await page.evaluate((phase) => window.updateActivity({ phase }), phase);
    await expect(row).toHaveText(label);
    await expect(row.locator(`.lucide-${icon}`)).toHaveCount(1);
  }
  await page.evaluate(() =>
    window.updateActivity({
      phase: "tool",
      messages: [
        {
          id: "unknown",
          role: "tool",
          toolName: "future_connector",
          text: "",
          status: "running",
        },
      ],
    }),
  );
  await expect(row.locator(".lucide-wrench")).toHaveCount(1);
  await page.evaluate(() => window.updateActivity({ finishTool: true }));
  await expect(row).toContainText("Used tool");
  await expect(row.locator(".shimmer")).toHaveCount(0);
  await page.evaluate(() =>
    window.updateActivity({
      phase: "cancelled",
      messages: [
        {
          id: "partial",
          role: "assistant",
          text: "Partial answer stays readable.",
        },
      ],
    }),
  );
  await expect(
    page.getByText("Partial answer stays readable.", { exact: true }),
  ).toBeVisible();
});


test("initial waiting indicator has no icon before the first response", async ({ page }) => {
  await setup(page, "empty");
  const indicator = page.locator('[data-slot="aui_assistant-message-indicator"]');
  await expect(indicator).toHaveText("Working…");
  await expect(indicator.locator("svg")).toHaveCount(0);
  await page.evaluate(() => window.updateActivity({ messages: [{ id: "first-reply", role: "assistant", text: "", thinking: "Hidden reasoning" }] }));
  await expect(indicator).toHaveCount(0);
  const row = page.locator('[data-slot="activity-progress"]');
  await expect(row).toHaveText("Thinking");
  await expect(row.locator("svg")).toHaveCount(0);
});


test("narration wraps without shimmer and stays visible across tools", async ({ page }) => {
  await setup(page);
  const narration = "这是一段正常的说明文字，应该完整展示并自动换行。".repeat(20);
  await page.evaluate(text => window.updateActivity({ messages: [{ id: "narration", role: "assistant", text }] }), narration);
  const paragraph = page.getByText(narration, { exact: true });
  await expect(paragraph).toBeVisible();
  await expect(page.locator('[data-slot="activity-progress"]')).toHaveCount(0);
  const section = page.locator(".worklens-activity-section");
  const body = page.locator('[data-has-activity="true"]').first();
  const gap = (await body.boundingBox()).y - ((await section.boundingBox()).y + (await section.boundingBox()).height);
  expect(gap).toBeGreaterThanOrEqual(0);
  expect(gap).toBeLessThanOrEqual(12);
  await expect(paragraph).toHaveCSS("white-space", "normal");
  await expect(paragraph).toHaveCSS("animation-name", "none");
  expect(await paragraph.evaluate(node => getComputedStyle(node, "::after").content)).toBe("none");
  expect(await paragraph.evaluate(node => !!node.closest(".shimmer"))).toBe(false);
  expect((await paragraph.boundingBox()).height).toBeGreaterThan(50);
  await paragraph.evaluate(node => window.narrationNode = node);
  await expect(page.locator('[data-slot="aui_assistant-message-indicator"]')).toHaveCount(0);
  for (let i = 0; i < 3; i++) {
    await page.evaluate(i => window.updateActivity({ phase: "tool", messages: [{ id: `tool-${i}`, role: "tool", toolName: "web_search", text: "", args: JSON.stringify({ query: `search-${i}` }), status: "running" }] }), i);
    await expect(paragraph).toBeVisible();
    expect(await paragraph.evaluate(node => window.narrationNode === node)).toBe(true);
    await expect(page.locator('[data-slot="activity-progress"]')).toHaveText(`Searching · search-${i}`);
    await expect(page.locator('[data-slot="activity-progress"]')).toHaveCount(1);
  }
  await page.evaluate(() => window.updateActivity({ finishTool: true, messages: [{ id: "final", role: "assistant", text: "Final response streams normally." }] }));
  await expect(page.getByText("Final response streams normally.", { exact: true })).toBeVisible();
  await page.evaluate(() => window.updateActivity({ phase: "completed" }));
  await expect(paragraph).toHaveCount(0);
  await expect(page.getByText("Final response streams normally.", { exact: true })).toBeVisible();
});


test("short and long activity text share shimmer velocity and pause", async ({ page }) => {
  await setup(page, true);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const text = page.locator('[data-slot="activity-progress"] > span');
  const metrics = () => text.evaluate(node => {
    const style = getComputedStyle(node);
    return { width: node.clientWidth, track: parseFloat(style.getPropertyValue("--shimmer-track-width")), speed: style.getPropertyValue("--shimmer-speed"), pause: style.getPropertyValue("--shimmer-repeat-delay"), duration: parseFloat(style.animationDuration) };
  });
  await expect.poll(async () => (await metrics()).track).toBeGreaterThan(0);
  const thinking = await metrics();
  await page.evaluate(() => window.updateActivity({ phase: "tool", messages: [{ id: "long-bash", role: "tool", toolName: "bash", args: JSON.stringify({ command: "rg --files " + "directory/".repeat(100) }), text: "", status: "running" }] }));
  await expect(text).toContainText("Running bash");
  await expect.poll(async () => (await metrics()).track).toBeGreaterThan(thinking.track);
  const bash = await metrics();
  expect(bash.track).toBe(bash.width);
  expect(bash.speed).toBe(thinking.speed);
  expect(bash.pause).toBe(thinking.pause);
  // Added visible distance gets proportional extra time, not a faster sweep.
  expect((bash.track - thinking.track) / (bash.duration - thinking.duration)).toBeCloseTo(Number(thinking.speed), 0);
  await page.setViewportSize({ width: 850, height: 900 });
  await expect.poll(async () => (await metrics()).track).toBeLessThan(bash.track);
  const narrow = await metrics();
  expect(narrow.track).toBe(narrow.width);
  expect(narrow.speed).toBe(thinking.speed);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(text).toHaveCSS("animation-name", "none");
});


test("Thinking and narration use a compact gap", async ({ page }, testInfo) => {
  await setup(page);
  await page.evaluate(() => window.updateActivity({ messages: [{ id: "thinking", role: "assistant", text: "", thinking: "Hidden details" }] }));
  const row = page.locator('[data-slot="activity-progress"]');
  const paragraph = page.getByText("I will check the files first.", { exact: true });
  await expect(row).toHaveText("Thinking");
  const statusBox = await row.boundingBox();
  const paragraphBox = await paragraph.boundingBox();
  expect(statusBox.y - paragraphBox.y - paragraphBox.height).toBeGreaterThanOrEqual(0);
  expect(statusBox.y - paragraphBox.y - paragraphBox.height).toBeLessThanOrEqual(10);
  const header = await page.locator('.worklens-activity-section > div').first().boundingBox();
  expect(paragraphBox.y - header.y - header.height).toBeLessThanOrEqual(8);
  await page.evaluate(() => window.updateActivity({ phase: "tool", messages: [{ id: "read", role: "tool", toolName: "read", args: '{"path":"README.md"}', text: "", status: "running" }] }));
  await expect(row).toHaveText("Reading · README.md");
  expect((await row.boundingBox()).y).toBeGreaterThan((await paragraph.boundingBox()).y);
  await expect(row).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("compact-thinking-gap.png") });
});


test("new narration appends below the previous tool without rewriting earlier text", async ({ page }, testInfo) => {
  await setup(page);
  const first = page.getByText("I will check the files first.", { exact: true });
  await first.evaluate(node => { window.originalNode = node; window.originalText = node.textContent; });
  await page.evaluate(() => window.updateActivity({ phase: "tool", messages: [{ id: "read-1", role: "tool", toolName: "read", args: '{"path":"first.md"}', status: "running", text: "" }] }));
  await expect(page.locator('[data-slot="activity-progress"]')).toHaveText("Reading · first.md");
  const firstY = (await first.boundingBox()).y;
  await page.evaluate(() => window.updateActivity({ finishTool: true, messages: [{ id: "second-text", role: "assistant", text: "Now I will check another source." }] }));
  const second = page.getByText("Now I will check another source.", { exact: true });
  await expect(second).toBeVisible();
  const read = page.locator('[data-slot="activity-progress"]').filter({ hasText: "Read file" });
  await expect(read).toBeVisible();
  expect((await read.boundingBox()).y).toBeGreaterThan((await first.boundingBox()).y);
  expect((await second.boundingBox()).y).toBeGreaterThan((await read.boundingBox()).y);
  expect((await second.boundingBox()).y - (await read.boundingBox()).y - (await read.boundingBox()).height).toBeLessThanOrEqual(12);
  expect((await first.boundingBox()).y).toBe(firstY);
  expect(await first.evaluate(node => node === window.originalNode && node.textContent === window.originalText)).toBe(true);
  for (let i = 0; i < 3; i++) {
    await page.evaluate(i => window.updateActivity({ phase: "tool", messages: [{ id: `later-search-${i}`, role: "tool", toolName: "web_search", args: JSON.stringify({ query: `later-${i}` }), status: "running", text: "" }] }), i);
    const latest = page.locator('[data-slot="activity-progress"]').last();
    await expect(latest).toHaveText(`Searching · later-${i}`);
    await expect(page.locator('[data-slot="activity-progress"]')).toHaveCount(2);
    expect((await latest.boundingBox()).y).toBeGreaterThan((await second.boundingBox()).y);
    expect(await first.evaluate(node => node === window.originalNode && node.textContent === window.originalText)).toBe(true);
  }
  await page.screenshot({ path: testInfo.outputPath("ordered-progress.png") });
  await page.evaluate(() => window.updateActivity({ phase: "completed", finishTool: true, messages: [{ id: "final-text", role: "assistant", text: "The final result." }] }));
  await expect(page.getByText("The final result.", { exact: true })).toBeVisible();
  await expect(first).toHaveCount(0);
  await expect(second).toHaveCount(0);
});

test("finishing a live turn does not invent alternative message versions", async ({ page }) => {
  await setup(page);
  await page.evaluate(() => window.updateActivity({ phase: "tool", messages: [{ id: "read-for-branch", role: "tool", toolName: "read", args: '{"path":"README.md"}', text: "", status: "running" }] }));
  await page.evaluate(() => window.updateActivity({ finishTool: true, messages: [{ id: "branch-final", role: "assistant", text: "The only final answer." }] }));
  await expect(page.getByText("The only final answer.", { exact: true })).toBeVisible();
  await page.evaluate(() => window.updateActivity({ phase: "completed" }));
  await expect(page.getByText("The only final answer.", { exact: true })).toBeVisible();
  await expect(page.locator(".aui-branch-picker-root")).toHaveCount(0);
  await page.evaluate(() => window.updateActivity({ phase: "generating", messages: [
    { id: "next-user", role: "user", text: "One more question" },
    { id: "next-answer", role: "assistant", text: "Another single answer." },
  ] }));
  await page.evaluate(() => window.updateActivity({ phase: "completed" }));
  await expect(page.getByText("The only final answer.", { exact: true })).toBeVisible();
  await expect(page.getByText("Another single answer.", { exact: true })).toBeVisible();
  await expect(page.locator(".aui-branch-picker-root")).toHaveCount(0);
});

test("completed tools aggregate within narration boundaries", async ({ page }) => {
  await setup(page);
  await page.evaluate(() => window.updateActivity({ phase: "tool", messages: [
    { id: "r1", role: "tool", toolName: "read", args: '{"path":"a.md"}', status: "success", text: "" },
    { id: "r2", role: "tool", toolName: "read", args: '{"path":"b.md"}', status: "success", text: "" },
    { id: "b1", role: "tool", toolName: "bash", args: '{"command":"echo hello"}', status: "running", text: "" },
  ] }));
  const rows = page.locator('[data-slot="activity-progress"]');
  await expect(rows).toHaveText("Running bash · echo hello");
  await page.evaluate(() => window.updateActivity({ finishTool: true, messages: [
    { id: "next-narration", role: "assistant", text: "Next step." },
  ] }));
  await expect(rows).toHaveText("Read files, ran command");
  await expect(rows.locator(".shimmer")).toHaveCount(0);
  await page.evaluate(() => window.updateActivity({ phase: "tool", messages: [
    { id: "b2", role: "tool", toolName: "bash", args: '{"command":"echo next"}', status: "running", text: "" },
  ] }));
  await expect(rows).toHaveText(["Read files, ran command", "Running bash · echo next"]);
  await page.evaluate(() => window.updateActivity({ finishTool: true }));
  await expect(rows).toHaveText(["Read files, ran command", "Ran command"]);
});


test("empty narration never reserves a row and late text stays below the visible command", async ({ page }) => {
  await setup(page, true);
  await page.evaluate(() => window.updateActivity({ phase: "tool", patch: { id: "first", text: " \n " }, messages: [{ id: "early-command", role: "tool", toolName: "bash", args: '{"command":"pwd"}', text: "", status: "running" }] }));
  const row = page.locator('[data-slot="activity-progress"]');
  await expect(row).toHaveCount(1);
  await expect(page.locator('[data-slot="aui_assistant-message-root"][data-has-activity="true"]')).toHaveCount(0);
  const y = (await row.boundingBox()).y;
  await page.evaluate(() => window.updateActivity({ finishTool: true, patch: { id: "first", text: "The description arrived later." } }));
  const text = page.getByText("The description arrived later.", { exact: true });
  await expect(text).toBeVisible();
  expect((await row.boundingBox()).y).toBe(y);
  expect((await text.boundingBox()).y).toBeGreaterThan((await row.boundingBox()).y);
});
