import { expect, test, type Page } from "@playwright/test";
import { mockWorklens } from "./fixture.js";

async function setup(
  page: Page,
  text: string,
  streaming = false,
  theme = "light",
  language = "en",
) {
  await mockWorklens(page, {
    initialSettings: { theme: theme as "light" | "dark" },
  });
  await page.addInitScript(
    ({ text, streaming, language }) => {
      localStorage.setItem("worklens.language", language);
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: async (text: string) => {
            (window as any).copiedSnippet = text;
          },
        },
      });
      const invoke = window.worklens.invoke;
      let sequence = 0;
      const view = {
        id: "code-demo",
        title: "Synthetic code",
        phase: streaming ? "generating" : "completed",
        updatedAt: new Date().toISOString(),
        selection: { provider: "deepseek", model: "flash", thinking: "medium" },
        messages: [
          { id: "u", role: "user", text: "Explain an example workflow" },
          {
            id: "a",
            role: "assistant",
            text,
            runStartedAt: new Date(Date.now() - 1000).toISOString(),
            runCompletedAt: streaming ? undefined : new Date().toISOString(),
          },
        ],
      };
      window.worklens.onChat = (listener) => {
        (window as any).updateCode = (text: string, completed = true) => {
          view.messages[1].text = text;
          view.phase = completed ? "completed" : "generating";
          view.messages[1].runCompletedAt = completed
            ? new Date().toISOString()
            : undefined;
          listener({
            conversationId: view.id,
            runId: "code-stream",
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
    { text, streaming, language },
  );
  await page.goto("/");
}

const workflow = "flowchart LR\n  A[Draft] --> B[Review]\n  B --> C[Done]";
const fence = (language: string, code: string) =>
  `\`\`\`${language}\n${code}\n\`\`\``;

for (const theme of ["light", "dark"]) {
  test(`code blocks are highlighted by language: ${theme}`, async ({
    page,
  }, info) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const js = 'const label = "sample";';
    await setup(
      page,
      [
        fence("js", js),
        fence("python", 'print("sample")'),
        fence("text", js),
        fence("unknown-example", js),
        fence("mermaid", workflow),
      ].join("\n\n"),
      false,
      theme,
    );
    const answer = page.locator('[data-slot="aui_assistant-message-root"]');
    const jsBlock = answer.locator("pre").filter({ hasText: js }).first();
    await expect(jsBlock.locator(".hljs-keyword")).toHaveText("const");
    await expect(jsBlock.locator(".hljs-string")).toHaveText('"sample"');
    await expect(answer.locator(".language-python .hljs-string")).toHaveText(
      '"sample"',
    );
    await expect(answer.locator(".language-text .hljs-keyword")).toHaveCount(0);
    await expect(
      answer.locator(".language-unknown-example .hljs-keyword"),
    ).toHaveCount(0);
    // Diagram sources stay readable code; they are not rendered.
    const mermaid = answer.locator("pre").filter({ hasText: "flowchart LR" });
    await expect(mermaid).toHaveText(`${workflow}\n`);
    await expect(mermaid.locator("img, svg, [class*='hljs-']")).toHaveCount(0);
    const keyword = await jsBlock.locator(".hljs-keyword").evaluate((node) => ({
      color: getComputedStyle(node).color,
      expected: getComputedStyle(document.documentElement)
        .getPropertyValue("--syntax-keyword")
        .trim(),
    }));
    expect(keyword.color).toBe(
      theme === "light" ? "rgb(6, 107, 219)" : "rgb(131, 183, 255)",
    );
    await jsBlock.hover();
    await answer.locator(".aui-code-copy").first().click();
    await expect
      .poll(() => page.evaluate(() => (window as any).copiedSnippet))
      .toBe(`${js}\n`);
    await page.setViewportSize({ width: 850, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({ path: info.outputPath(`code-${theme}.png`) });
    expect(errors).toEqual([]);
  });
}

test("streamed code is highlighted once the message completes", async ({
  page,
}) => {
  await setup(page, fence("js", 'const label = "draft";'), true);
  await expect(page.locator(".aui-md-pre")).toContainText("draft");
  await expect(page.locator(".hljs-keyword")).toHaveCount(0);
  await page.evaluate(
    (text) => (window as any).updateCode(text),
    fence("js", 'const label = "done";'),
  );
  await expect(page.locator(".hljs-keyword")).toHaveText("const");
});
