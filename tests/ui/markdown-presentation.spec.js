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
            thinking: "Review the sources.",
            runStartedAt: "2026-09-17T00:00:00Z",
            runCompletedAt: "2026-09-17T00:00:15Z",
            text: "已抓取页面内容，以下是翻译与总结。\n\n---\n\n## 保存位置\n\n```\n/Users/example/artifacts/laundry/\n├── 01_洗衣房全景_2048px.jpg\n└── 02_洗衣机面板.jpg\n```\n\n来源：`https://example.com/images/1mc5d12000tahizgkE791_W_2048_1536_laundry_original_image.jpg`，普通参数 `max_results`。\n\n```js\nconst source = 'https://example.com';\n```",
          },
        ],
      };
      view.messages[1].text += "\n\n首页增加了独立区域，模拟：\n\n```text\nRecently Updated macro\n```\n\n```plaintext\nPlain text content\n```\n\n```txt\nAnother text snippet\n```\n\n```bash\nnpm run build\n```";
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
    await expect(page.locator(".aui-code-header-language")).toHaveText(["js", "bash"]);
    const plain = page.locator(".aui-md-pre").filter({ hasText: "Recently Updated macro" });
    await expect(plain).toHaveCSS("padding-top", "12px");
    await expect(plain).toHaveCSS("border-radius", "11px");
    await expect(page.locator(".aui-md-pre").filter({ hasText: "npm run build" })).toHaveCSS("padding-top", "36px");
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
    const trigger = page.locator('[data-slot="reasoning-trigger"]');
    await trigger.click();
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
