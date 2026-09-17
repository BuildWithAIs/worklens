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
            text: "[Website](https://example.com/path?q=1#section)\n\nhttp://example.org\n\n[File](/tmp/example.txt)\n\n`https://example.com/image.jpg`\n\n[`https://example.com/nested`](https://example.com/nested)\n\n`max_results`\n\n来源：（https://www.yzwb.net/news/tt/202609/t20260916_393366.html）。预报会更新，出门前建议再看一次当天实时。",
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
    const weather = page.getByRole("link", {
      name: "https://www.yzwb.net/news/tt/202609/t20260916_393366.html",
      exact: true,
    });
    await weather.click();
    expect((await page.evaluate(() => window.externalLinks)).at(-1)).toBe(
      "https://www.yzwb.net/news/tt/202609/t20260916_393366.html",
    );
    await expect(
      page.locator("a").filter({ hasText: "预报会更新" }),
    ).toHaveCount(0);
    await expect(
      page.getByText(/预报会更新，出门前建议再看一次当天实时。/),
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
