import { test, expect } from "@playwright/test";
import { mockWorklens } from "./fixture.js";

for (const theme of ["light", "dark"]) {
  test(`markdown code actions and separators stay quiet: ${theme}`, async ({
    page,
  }, info) => {
    await mockWorklens(page);
    await page.addInitScript(() => {
      const invoke = window.worklens.invoke;
      const view = {
        id: "markdown",
        title: "Markdown presentation",
        phase: "completed",
        updatedAt: new Date().toISOString(),
        messages: [
          { id: "u", role: "user", text: "整理图片并提供保存位置" },
          {
            id: "a",
            role: "assistant",
            thinking: "## Sources\n\nReview the sources.",
            runStartedAt: "2026-09-17T00:00:00Z",
            runCompletedAt: "2026-09-17T00:00:15Z",
            text: "已准备好示例图片，下面列出文件位置。\n\n---\n\n## 示例文件\n\n```\n/Users/example/artifacts/sample-media/\n├── sample-overview.jpg\n└── sample-detail.jpg\n```\n\n来源：`https://images.example.test/assets/synthetic-landscape-preview-with-extra-description-2048-by-1536.jpg`，普通参数 `max_results`。\n\n```js\nconst source = 'https://example.test';\n```",
          },
        ],
      };
      view.messages[1].text +=
        "\n\n首页增加了独立区域，模拟：\n\n```text\nRecently Updated macro\n```\n\n```plaintext\nPlain text content\n```\n\n```txt\nAnother text snippet\n```\n\n```bash\nnpm run build\n```\n\n## 后续\n\n### 本周\n\n- 收集资料\n  - 会议纪要\n- 指定负责人\n\n## 附录\n\n# 总结\n\n| 模块 | 说明 |\n| --- | --- |\n| 导出器 | 把整理好的示例周报按模板导出为文档；导出失败时保留草稿，下次打开可以继续编辑、核对内容并重新导出。 |";
      window.worklens.invoke = async (name, input) => {
        if (name === "open") return view;
        const result = await invoke(name, input);
        if (name === "bootstrap") {
          result.conversations = [view];
          result.settings.lastConversation = view.id;
        }
        return result;
      };
    });
    await page.goto("/");
    await page.evaluate(
      (theme) => (document.documentElement.dataset.theme = theme),
      theme,
    );
    const pre = page.locator(".aui-md-pre").first();
    const copy = page.locator(".aui-code-copy").first();
    await expect(page.locator(".aui-code-header-language")).toHaveText([
      "js",
      "bash",
    ]);
    const plain = page
      .locator(".aui-md-pre")
      .filter({ hasText: "Recently Updated macro" });
    await expect(plain).toHaveCSS("padding-top", "12px");
    await expect(plain).toHaveCSS("border-radius", "11px");
    await expect(
      page.locator(".aui-md-pre").filter({ hasText: "npm run build" }),
    ).toHaveCSS("padding-top", "36px");
    await page.locator(".chat-header").hover();
    await expect(copy).toHaveCSS("opacity", "0");
    const height = (await pre.boundingBox()).height;
    await pre.hover();
    await expect(copy).toHaveCSS("opacity", "1");
    expect((await pre.boundingBox()).height).toBe(height);
    await copy.click();
    await expect(copy.locator(".lucide-check")).toHaveCount(1);
    await page.locator(".chat-header").hover();
    await copy.focus();
    await expect(copy).toHaveCSS("opacity", "1");
    await expect(page.locator(".worklens-activity-section")).toHaveCSS(
      "border-bottom-width",
      "1px",
    );
    await expect(page.locator(".aui-md-hr")).toBeVisible();
    const spacing = await page.evaluate(() => {
      const activity = document
        .querySelector(".worklens-activity-section")
        .getBoundingClientRect();
      const answer = document.querySelector(
        '[data-slot="aui_assistant-message-root"][data-has-activity="true"]',
      );
      const paragraph = answer
        .querySelector(".aui-md-p")
        .getBoundingClientRect();
      const rule = answer.querySelector(".aui-md-hr").getBoundingClientRect();
      return {
        before: paragraph.top - activity.bottom,
        after: rule.top - paragraph.bottom,
      };
    });
    expect(spacing.before).toBeCloseTo(14, 0);
    expect(spacing.after).toBeCloseTo(spacing.before, 0);
    // Headings sit closer to their content than to the section before, and
    // nested items stay with their parent item.
    const rhythm = await page.evaluate(() => {
      const reply = document.querySelector(".aui-md-reply");
      const gap = (a, b) =>
        b.getBoundingClientRect().top - a.getBoundingClientRect().bottom;
      const [h2, appendix] = [...reply.querySelectorAll(".aui-md-h2")].slice(
        -2,
      );
      const h3 = h2.nextElementSibling;
      const list = h3.nextElementSibling;
      const [first, second] = list.querySelectorAll(":scope > li");
      const nested = first.querySelector(".aui-md-ul");
      return {
        headings: gap(h2, h3),
        // A model may follow ## with #; the pair keeps the same spacing.
        promoted: gap(appendix, appendix.nextElementSibling),
        content: gap(h3, list),
        nested: gap(nested, second),
        indent:
          nested.getBoundingClientRect().left -
          list.getBoundingClientRect().left,
      };
    });
    expect(rhythm.headings).toBeCloseTo(12, 0);
    expect(rhythm.promoted).toBeCloseTo(12, 0);
    expect(rhythm.content).toBeCloseTo(8, 0);
    expect(rhythm.nested).toBeCloseTo(4, 0);
    expect(rhythm.indent).toBeGreaterThan(0);
    // Section headings look the same whichever of # or ## the model chose.
    await expect(page.locator(".aui-md-reply .aui-md-h1")).toHaveCSS(
      "font-size",
      "17px",
    );
    // A long column cannot squeeze short labels into one character per line.
    const labelLines = await page.evaluate(() =>
      [...document.querySelectorAll(".aui-md-reply tr > :first-child")]
        .filter((cell) => ["模块", "导出器"].includes(cell.textContent))
        .map((cell) => {
          const range = document.createRange();
          range.selectNodeContents(cell);
          return new Set(
            [...range.getClientRects()].map((rect) => Math.round(rect.top)),
          ).size;
        }),
    );
    expect(labelLines).toEqual([1, 1]);
    const trigger = page.locator('[data-slot="reasoning-trigger"]');
    await trigger.click();
    // Thinking shares the markdown renderer but keeps its compact headings.
    const thinkingHeading = page
      .locator(".worklens-activity-section")
      .locator(".aui-md-h2");
    await expect(thinkingHeading).toHaveCSS("font-size", "15px");
    await expect(thinkingHeading).toHaveCSS("font-weight", "500");
    await expect(page.locator(".worklens-activity-section")).toHaveCSS(
      "border-bottom-width",
      "1px",
    );
    await trigger.click();
    await expect(page.locator(".worklens-activity-section")).toHaveCSS(
      "border-bottom-width",
      "1px",
    );
    await page.screenshot({ path: info.outputPath(`markdown-${theme}.png`) });
    await page.setViewportSize({ width: 850, height: 900 });
    await expect(page.locator(".aui-md-code-link")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath("markdown-narrow-" + theme + ".png"),
    });
    await plain.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`plain-text-${theme}.png`) });
  });
}
