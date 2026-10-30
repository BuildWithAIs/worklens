import { test, expect } from "@playwright/test";
import { mockWorklens } from "./fixture.js";
for (const language of ["en", "zh"]) {
  test(`chat web links use external browser and localize failures (${language})`, async ({
    page,
  }) => {
    await mockWorklens(page);
    await page.addInitScript((language) => {
      localStorage.setItem("worklens.language", language);
      const invoke = window.worklens.invoke;
      const view = {
        id: "links",
        title: "Links",
        phase: "completed",
        updatedAt: new Date().toISOString(),
        messages: [
          { id: "u", role: "user", text: "Links" },
          {
            id: "a",
            role: "assistant",
            text: "[Website](https://example.com/path?q=1#section)\n\nhttp://example.org\n\n[File](/tmp/example.txt)\n\n`https://example.com/image.jpg`\n\n[`https://example.com/nested`](https://example.com/nested)\n\n`max_results`\n\n来源：（https://news.example.test/guides/sample-entry.html）。说明会更新，请查看页面上的最新内容。",
          },
        ],
      };
      window.externalLinks = [];
      window.worklens.invoke = async (method, input) => {
        if (method === "external") {
          window.externalLinks.push(input.url);
          if (window.failOpen) throw new Error("Fixture open failure");
          return;
        }
        if (method === "open") return view;
        const result = await invoke(method, input);
        if (method === "bootstrap") {
          result.conversations = [view];
          result.settings.lastConversation = view.id;
        }
        return result;
      };
    }, language);
    await page.goto("/");
    const initialUrl = page.url();
    const website = page.getByRole("link", { name: "Website", exact: true });
    await website.click();
    expect(await page.evaluate(() => window.externalLinks)).toEqual([
      "https://example.com/path?q=1#section",
    ]);
    await expect(page).toHaveURL(initialUrl);
    await website.focus();
    await page.keyboard.press("Enter");
    await expect
      .poll(() => page.evaluate(() => window.externalLinks.length))
      .toBe(2);
    await page
      .getByRole("link", { name: "http://example.org", exact: true })
      .click();
    expect(await page.evaluate(() => window.externalLinks[2])).toMatch(
      /^http:\/\/example.org\/?$/,
    );
    const inline = page.getByRole("link", {
      name: "https://example.com/image.jpg",
      exact: true,
    });
    await inline.click();
    await inline.click({ modifiers: ["ControlOrMeta"] });
    await inline.focus();
    await page.keyboard.press("Enter");
    expect((await page.evaluate(() => window.externalLinks)).slice(-3)).toEqual(
      Array(3).fill("https://example.com/image.jpg"),
    );
    await expect(page.locator("a a")).toHaveCount(0);
    await expect(
      page.locator("code").filter({ hasText: /^max_results$/ }),
    ).toHaveCount(1);
    const sourceLink = page.getByRole("link", {
      name: "https://news.example.test/guides/sample-entry.html",
      exact: true,
    });
    await sourceLink.click();
    expect((await page.evaluate(() => window.externalLinks)).at(-1)).toBe(
      "https://news.example.test/guides/sample-entry.html",
    );
    await expect(
      page.locator("a").filter({ hasText: "说明会更新" }),
    ).toHaveCount(0);
    await expect(
      page.getByText(/说明会更新，请查看页面上的最新内容。/),
    ).toBeVisible();
    await page.evaluate(() => {
      window.failOpen = true;
    });
    await website.click();
    await expect(page.locator('[data-slot="toast-title"]')).toHaveText(
      language === "en" ? "Couldn’t open the link" : "未能打开链接",
    );
    await expect(page).toHaveURL(initialUrl);
  });
}

for (const theme of ["light", "dark"]) {
  test(`www links stop before Chinese prose and restore inline code (${theme})`, async ({
    page,
  }, info) => {
    await mockWorklens(page);
    await page.addInitScript(() => {
      const invoke = window.worklens.invoke;
      const view = {
        id: "cjk-links",
        title: "信息来源",
        phase: "completed",
        updatedAt: new Date().toISOString(),
        messages: [
          {
            id: "a",
            role: "assistant",
            text: "## 信息来源\n\n- 示例文档站点 www.docs.example.test（页面导航说明、`/guide/intro/` 站点说明，支持代码与标点解析）\n- 参考 www.example.com（`page details`，**页面说明**）",
          },
        ],
      };
      window.externalLinks = [];
      window.worklens.invoke = async (method, input) => {
        if (method === "external") {
          window.externalLinks.push(input.url);
          return;
        }
        if (method === "open") return view;
        const result = await invoke(method, input);
        if (method === "bootstrap") {
          result.conversations = [view];
          result.settings.lastConversation = view.id;
        }
        return result;
      };
    });
    await page.goto("/");
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    const link = page.getByRole("link", {
      name: "www.docs.example.test",
      exact: true,
    });
    await expect(link).toHaveAttribute("href", "http://www.docs.example.test");
    await expect(
      page.locator("a").filter({ hasText: "页面导航说明" }),
    ).toHaveCount(0);
    await expect(
      page.locator("code").filter({ hasText: /^\/guide\/intro\/$/ }),
    ).toBeVisible();
    await expect(
      page.locator('[data-slot="local-file-reference"]'),
    ).toHaveCount(0);
    await expect(
      page.locator("code").filter({ hasText: /^page details$/ }),
    ).toBeVisible();
    await expect(
      page.locator("strong").filter({ hasText: "页面说明" }),
    ).toBeVisible();
    await link.hover();
    await expect(page.locator('[data-slot="tooltip-content"]')).toContainText(
      "http://www.docs.example.test",
    );
    await link.click();
    await link.focus();
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => window.externalLinks)).toEqual([
      "http://www.docs.example.test",
      "http://www.docs.example.test",
    ]);
    await page.locator(".chat-header").hover();
    await page.screenshot({ path: info.outputPath(`cjk-links-${theme}.png`) });
  });
}

test("long URL labels shorten without changing navigation or descriptive labels", async ({
  page,
}) => {
  await mockWorklens(page);
  const url =
    "https://example.com/" +
    "long-path/".repeat(12) +
    "report.html?version=complete";
  await page.addInitScript((url) => {
    const invoke = window.worklens.invoke;
    const view = {
      id: "long-url",
      title: "Links",
      phase: "completed",
      updatedAt: new Date().toISOString(),
      messages: [
        {
          id: "a",
          role: "assistant",
          text: url + "\n\n[Read the report](" + url + ")\n\n`" + url + "`",
        },
      ],
    };
    window.worklens.invoke = async (name, input) => {
      if (name === "external") {
        window.openedUrl = input.url;
        return;
      }
      if (name === "open") return view;
      const result = await invoke(name, input);
      if (name === "bootstrap") {
        result.conversations = [view];
        result.settings.lastConversation = view.id;
      }
      return result;
    };
  }, url);
  await page.goto("/");
  const shortened = page.getByRole("link", {
    name: "example.com/…/report.html?…",
    exact: true,
  });
  await expect(shortened).toHaveCount(2);
  await expect(shortened.first()).toHaveAttribute("href", url);
  await shortened.first().hover();
  await expect(page.locator('[data-slot="tooltip-content"]')).toContainText(
    url,
  );
  await shortened.first().click();
  expect(await page.evaluate(() => window.openedUrl)).toBe(url);
  await expect(
    page.getByRole("link", { name: "Read the report", exact: true }),
  ).toHaveAttribute("href", url);
});
