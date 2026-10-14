import { expect, test, type Page } from "@playwright/test";
import { mockWorklens } from "./fixture.js";

async function setup(page: Page, text: string, streaming = false) {
  await mockWorklens(page);
  await page.addInitScript(
    ({ text, streaming }) => {
      const invoke = window.worklens.invoke;
      let sequence = 0;
      const view = {
        id: "math-demo",
        title: "Synthetic math example",
        phase: streaming ? "generating" : "completed",
        updatedAt: new Date().toISOString(),
        selection: { provider: "deepseek", model: "flash", thinking: "medium" },
        messages: [
          { id: "u", role: "user", text: "Explain a geometric expression" },
          {
            id: "a",
            role: "assistant",
            text,
            thinking: "Check $a^2 + b^2 = c^2$ first.",
            runStartedAt: new Date(Date.now() - 12000).toISOString(),
            runCompletedAt: streaming ? undefined : new Date().toISOString(),
          },
        ],
      };
      window.worklens.onChat = (listener) => {
        (window as any).updateMath = (text: string, completed = false) => {
          view.messages[1].text = text;
          view.phase = completed ? "completed" : "generating";
          if (completed)
            view.messages[1].runCompletedAt = new Date().toISOString();
          listener({
            conversationId: view.id,
            runId: "math-stream",
            sequence: ++sequence,
            type: "message_update",
            view: structuredClone(view) as any,
          });
        };
        return () => {};
      };
      window.worklens.invoke = (async (name: string, input: any) => {
        if (name === "open") return structuredClone(view);
        const result = await (invoke as any)(name, input);
        if (name === "bootstrap") {
          result.conversations = [view];
          result.settings.lastConversation = view.id;
        }
        return result;
      }) as typeof window.worklens.invoke;
    },
    { text, streaming },
  );
  await page.goto("/");
}

for (const theme of ["light", "dark"]) {
  test(`math follows message typography and stays inside narrow layouts: ${theme}`, async ({
    page,
  }, info) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const text = [
      String.raw`Mapping $x \mapsto x^2$. Also \(a + b\).`,
      "Prices: $18 and $27.",
      String.raw`\[\frac{1}{2}\]`,
      `$$\n${"a + ".repeat(100)}z\n$$`,
      "| Label | Expression |\n| --- | --- |\n| Area | $r^2$ |",
      "```text\n$18 and \\(a + b\\)\n```",
      String.raw`Invalid $\frac{$ expression.`,
    ].join("\n\n");
    await setup(page, text);
    await page.evaluate(
      (theme) => (document.documentElement.dataset.theme = theme),
      theme,
    );
    const answer = page.locator('[data-slot="aui_assistant-message-root"]');
    await expect(answer.locator(".katex")).toHaveCount(5);
    await expect(answer.locator(".katex-mathml math")).toHaveCount(5);
    await expect(
      answer.locator(".aui-md-p").filter({ hasText: "Prices:" }),
    ).toHaveText("Prices: $18 and $27.");
    await expect(answer.locator(".aui-md-pre code")).toHaveText(
      "$18 and \\(a + b\\)\n",
    );
    await expect(answer.locator(".katex-error")).toBeVisible();
    await expect(answer.locator(".aui-md-table .katex")).toHaveCount(1);
    await page.evaluate(() => document.fonts.ready);
    const typography = await answer
      .locator(".katex")
      .first()
      .evaluate((node) => {
        const paragraph = node.closest(".aui-md-p")!;
        return {
          mathSize: getComputedStyle(node).fontSize,
          textSize: getComputedStyle(paragraph).fontSize,
          mathColor: getComputedStyle(node).color,
          textColor: getComputedStyle(paragraph).color,
          fontLoaded: document.fonts.check('14px "KaTeX_Main"'),
        };
      });
    expect(typography.mathSize).toBe(typography.textSize);
    expect(typography.mathColor).toBe(typography.textColor);
    expect(typography.fontLoaded).toBe(true);
    await page.locator('[data-slot="reasoning-trigger"]').click();
    await expect(
      page.locator(".worklens-activity-section .katex"),
    ).toBeVisible();
    await page.locator('[data-slot="reasoning-trigger"]').click();
    await page.setViewportSize({ width: 850, height: 900 });
    const longMath = answer.locator(".katex-display").nth(1);
    expect(
      await longMath.evaluate((node) => node.scrollWidth > node.clientWidth),
    ).toBe(true);
    await expect(longMath).toHaveCSS("overflow-x", "auto");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({ path: info.outputPath(`math-${theme}.png`) });
    expect(errors).toEqual([]);
  });
}

test("unfinished streamed formulas and code settle into their final rendering", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await setup(page, "Start \\(\\frac{", true);
  await expect(
    page.locator(".aui-md").filter({ hasText: "Start" }),
  ).toBeVisible();
  const text = "Start \\(\\frac{1}{2}\\).\n\n~~~text\n$18 and \\(a + b\\)";
  await page.evaluate((text) => (window as any).updateMath(text), text);
  await expect(page.locator(".aui-md .katex")).toHaveCount(1);
  await expect(page.locator(".aui-md-pre code")).toHaveText(
    "$18 and \\(a + b\\)\n",
  );
  await page.evaluate(
    (text) => (window as any).updateMath(text, true),
    `${text}\n~~~`,
  );
  await expect(page.locator(".aui-md .katex")).toHaveCount(1);
  await expect(page.locator(".aui-md-pre code")).toHaveText(
    "$18 and \\(a + b\\)\n",
  );
  expect(errors).toEqual([]);
});
