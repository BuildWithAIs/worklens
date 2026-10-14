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
        title: "Synthetic code and diagram",
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
  test(`highlighting and diagrams share code block presentation: ${theme}`, async ({
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
        fence(
          "mermaid",
          "sequenceDiagram\n  participant A as Writer\n  participant B as Reviewer\n  A->>B: Draft\n  B-->>A: Feedback",
        ),
        fence(
          "mermaid",
          "stateDiagram-v2\n  [*] --> Draft\n  Draft --> Complete",
        ),
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
    await expect(answer.locator(".aui-mermaid > img")).toHaveCount(3);
    await expect(answer.locator(".aui-mermaid > img").first()).toBeVisible();
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
    const diagram = answer.locator(".aui-mermaid").first();
    await diagram.hover();
    await answer.locator(".aui-code-copy").nth(4).click();
    await expect
      .poll(() => page.evaluate(() => (window as any).copiedSnippet))
      .toBe(`${workflow}\n`);
    await diagram
      .getByRole("button", { name: "Show source", exact: true })
      .click();
    await expect(diagram.locator("pre")).toHaveText(`${workflow}\n`);
    await diagram
      .getByRole("button", { name: "Show diagram", exact: true })
      .click();
    const expand = diagram.getByRole("button", {
      name: "Expand diagram",
      exact: true,
    });
    await expand.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("dialog").getByRole("img")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(expand).toBeFocused();
    const dimensions = await page.evaluate(() => {
      const code = document.querySelector(".aui-md-pre")!;
      const diagram = document.querySelector(".aui-mermaid")!;
      const first = getComputedStyle(code),
        second = getComputedStyle(diagram);
      return {
        code: [
          first.paddingTop,
          first.paddingLeft,
          first.borderRadius,
          first.fontSize,
        ],
        diagram: [
          second.paddingTop,
          second.paddingLeft,
          second.borderRadius,
          second.fontSize,
        ],
      };
    });
    expect(dimensions.diagram).toEqual(dimensions.code);
    await page.setViewportSize({ width: 850, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await diagram.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath(`code-diagram-${theme}.png`),
    });
    await expect
      .poll(() => page.locator("[data-mermaid-scratch]").count())
      .toBe(0);
    expect(errors).toEqual([]);
  });
}

test("unfinished code settles into a diagram and theme changes re-render it", async ({
  page,
}) => {
  await setup(page, fence("mermaid", "flowchart LR\n  A -->"), true);
  await expect(page.locator(".aui-md-pre")).toContainText("A -->");
  await expect(page.locator(".aui-mermaid")).toHaveCount(0);
  await page.evaluate(
    (text) => (window as any).updateCode(text),
    fence("mermaid", workflow),
  );
  const image = page.locator(".aui-mermaid > img");
  await expect(image).toBeVisible();
  const light = await image.getAttribute("src");
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await expect(image).toBeVisible();
  await expect.poll(() => image.getAttribute("src")).not.toBe(light);
  await page.evaluate(
    (text) => (window as any).updateCode(text, false),
    fence("js", 'const label = "draft";'),
  );
  await expect(page.locator(".hljs-keyword")).toHaveCount(0);
  await page.evaluate(
    (text) => (window as any).updateCode(text),
    fence("js", 'const label = "done";'),
  );
  await expect(page.locator(".hljs-keyword")).toHaveText("const");
});

for (const language of ["en", "zh"]) {
  test(`invalid and oversized diagrams preserve source and recover: ${language}`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await setup(
      page,
      fence("mermaid", "flowchart LR\n  A -->"),
      false,
      "light",
      language,
    );
    await expect(page.getByRole("status")).toHaveText(
      language === "en"
        ? "Couldn’t render this diagram. The source is shown above."
        : "无法渲染此图表。源码已显示在上方。",
    );
    await expect(page.locator(".aui-md-pre")).toContainText("A -->");
    await page.evaluate(
      (text) => (window as any).updateCode(text),
      fence("mermaid", "x".repeat(50_001)),
    );
    await expect(page.getByRole("status")).toContainText(
      language === "en" ? "Couldn’t" : "无法",
    );
    await page.evaluate(
      (text) => (window as any).updateCode(text),
      fence("mermaid", workflow),
    );
    await expect(page.locator(".aui-mermaid > img")).toBeVisible();
    await expect(page.getByRole("status")).toHaveCount(0);
    await expect
      .poll(() => page.locator("[data-mermaid-scratch]").count())
      .toBe(0);
    expect(errors).toEqual([]);
  });
}

test("untrusted diagrams remain inert and canceled renders do not return stale images", async ({
  page,
}) => {
  const external: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith("https://example.invalid/"))
      external.push(request.url());
  });
  const untrusted = `%%{init: {"securityLevel":"loose","htmlLabels":true}}%%\nflowchart LR\n  A["<img src='https://example.invalid/pixel' onerror='window.diagramExecuted=true'>"] --> B[Safe]\n  click B "javascript:alert(1)"`;
  await setup(page, fence("mermaid", untrusted));
  await expect(page.getByRole("status")).toContainText("Couldn’t render");
  expect(
    await page.evaluate(() => (window as any).diagramExecuted),
  ).toBeUndefined();
  expect(external).toEqual([]);
  await page.evaluate(
    (text) => (window as any).updateCode(text),
    fence(
      "mermaid",
      '%%{init: {"securityLevel":"loose","htmlLabels":true}}%%\nflowchart LR\n  A[Safe] --> B[Done]\n  click B "javascript:alert(1)"',
    ),
  );
  await expect(page.locator(".aui-mermaid > img")).toBeVisible();
  const svg = decodeURIComponent(
    (await page.locator(".aui-mermaid > img").getAttribute("src"))!
      .split(",")
      .slice(1)
      .join(","),
  );
  expect(svg).not.toMatch(/<(?:script|image)\b/i);
  expect(svg).not.toMatch(/\b(?:href|xlink:href)=["']javascript:/i);
  expect(svg).not.toMatch(/\bon\w+=["']/i);
  await page.evaluate(
    (text) => {
      (window as any).updateCode(text);
      (window as any).updateCode("Only the final text should remain.");
    },
    fence("mermaid", "flowchart LR\n  X[Old result] --> Y[Discard]"),
  );
  await expect(
    page.getByText("Only the final text should remain.", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".aui-mermaid")).toHaveCount(0);
  await expect
    .poll(() => page.locator("[data-mermaid-scratch]").count())
    .toBe(0);
});

test("expanded tall diagrams fit the window and can be zoomed and scrolled", async ({
  page,
}, info) => {
  const steps = Array.from(
    { length: 24 },
    (_, index) =>
      `  S${index}[Step ${index}] --> S${index + 1}[Step ${index + 1}]`,
  );
  await setup(page, fence("mermaid", ["flowchart TD", ...steps].join("\n")));
  const diagram = page.locator(".aui-mermaid").first();
  await diagram.hover();
  await diagram
    .getByRole("button", { name: "Expand diagram", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  const viewport = dialog.locator(".aui-mermaid-expanded");
  const image = viewport.getByRole("img");
  await expect(image).toBeVisible();
  const fits = () =>
    viewport.evaluate((node) => {
      const view = node.getBoundingClientRect();
      const image = node.querySelector("img")!.getBoundingClientRect();
      return image.top >= view.top && image.bottom <= view.bottom;
    });
  expect(await fits()).toBe(true);
  await page.evaluate(() => {
    document.documentElement.dataset.nativeVibrancy = "true";
  });
  // macOS window controls sit at 20px; the dialog must start below them.
  await expect
    .poll(async () => (await dialog.boundingBox())!.y)
    .toBeGreaterThanOrEqual(44);
  expect(await fits()).toBe(true);
  await page.screenshot({ path: info.outputPath("diagram-fit.png") });

  const zoom = dialog.getByRole("group", { name: "Zoom" });
  const before = await zoom
    .getByRole("button", { name: "Actual size" })
    .textContent();
  await zoom.getByRole("button", { name: "Zoom in", exact: true }).click();
  await zoom.getByRole("button", { name: "Zoom in", exact: true }).click();
  await zoom.getByRole("button", { name: "Zoom in", exact: true }).click();
  await zoom.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(
    zoom.getByRole("button", { name: "Actual size" }),
  ).not.toHaveText(before!);
  expect(await fits()).toBe(false);
  await viewport.evaluate((node) => (node.scrollTop = node.scrollHeight));
  const bottomVisible = await viewport.evaluate((node) => {
    const view = node.getBoundingClientRect();
    return (
      node.querySelector("img")!.getBoundingClientRect().bottom <= view.bottom
    );
  });
  expect(bottomVisible).toBe(true);
  await zoom
    .getByRole("button", { name: "Fit to window", exact: true })
    .click();
  await expect.poll(fits).toBe(true);
});
