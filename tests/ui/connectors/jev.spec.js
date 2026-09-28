import { test, expect } from "@playwright/test";
import { mockJev, openConnectors } from "./jev-fixture.js";

for (const theme of ["light", "dark"]) {
  test(`Jev JSON viewer preserves space, copy access and long results: ${theme}`, async ({
    page,
  }, info) => {
    await mockJev(page, { theme, conversation: true });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text) => {
            window.copiedJevText = text;
          },
        },
      });
    });
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Sample feedback", exact: true }),
    ).toBeVisible();
    await page.evaluate(() => window.jevFixtureFinish());
    const marker = page.locator('[data-slot="jev-usage"]');
    await marker.click();
    const details = page.locator('[data-slot="popover-content"]');
    const code = details.locator("pre");
    const copy = details.getByRole("button", { name: "Copy", exact: true });
    const copyOverlay = copy.locator("..");
    await details.getByText("Jev", { exact: true }).click();
    await page.mouse.move(0, 0);
    await expect(copyOverlay).toHaveCSS("opacity", "0");
    expect(await code.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
      true,
    );
    await code.hover();
    await expect(copyOverlay).toHaveCSS("opacity", "1");
    await expect(copy.locator("svg")).toHaveCSS("width", "14px");
    expect(await copy.evaluate((el) => el.getBoundingClientRect().width)).toBe(
      24,
    );
    await page.mouse.move(0, 0);
    await code.focus();
    await expect(copyOverlay).toHaveCSS("opacity", "1");
    await copy.click();
    await expect
      .poll(() => page.evaluate(() => window.copiedJevText))
      .toBe(await code.textContent());
    await page.screenshot({ path: info.outputPath("jev-json-compact.png") });
    await page.keyboard.press("Escape");

    const answers = Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [
        `sample${i + 1}`,
        {
          type: "choice",
          choice:
            i === 0
              ? "independently-invented-long-category-".repeat(6)
              : "delivery",
        },
      ]),
    );
    await page.evaluate(
      (answers) => window.jevFixtureFinish("success", "sample-chat", answers),
      answers,
    );
    await marker.click();
    await expect(code).toContainText("sample60");
    const metrics = await code.evaluate((el) => ({
      height: el.clientHeight,
      scrollHeight: el.scrollHeight,
      width: el.clientWidth,
      scrollWidth: el.scrollWidth,
    }));
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.height);
    expect(metrics.scrollWidth).toBeGreaterThan(metrics.width);
    expect(
      await details.evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await code.hover();
    const buttonTop = await copy.evaluate(
      (el) => el.getBoundingClientRect().top,
    );
    await code.focus();
    await page.keyboard.press("ArrowDown");
    await expect
      .poll(() => code.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(0);
    await code.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    expect(await copy.evaluate((el) => el.getBoundingClientRect().top)).toBe(
      buttonTop,
    );
    await copy.click();
    expect(
      JSON.parse(await page.evaluate(() => window.copiedJevText)).answers,
    ).toEqual(answers);
    await page.setViewportSize({ width: 390, height: 700 });
    await expect
      .poll(() =>
        details.evaluate((el) => {
          const bounds = el.getBoundingClientRect();
          return (
            bounds.left >= 0 &&
            bounds.right <= window.innerWidth &&
            bounds.bottom <= window.innerHeight
          );
        }),
      )
      .toBe(true);
    await page.screenshot({
      path: info.outputPath("jev-json-long-narrow.png"),
    });
  });
}

for (const language of ["en", "zh"])
  for (const theme of ["light", "dark"]) {
    test(`Jev settings and shared connector management: ${language}, ${theme}`, async ({
      page,
    }, info) => {
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await mockJev(page, { language, theme, connected: false });
      const t = (en, zh) => (language === "en" ? en : zh);
      await page.goto("/");
      const content = await openConnectors(page, language);
      await content
        .getByRole("button", {
          name: t("Connect Jev", "连接 Jev"),
          exact: true,
        })
        .click();
      const dialog = page.getByRole("dialog", { name: "Jev", exact: true });
      await expect(dialog.locator("#jev-url")).toHaveValue(
        "https://api.typesafe.ai",
      );
      await dialog.locator("#jev-token").fill("synthetic-jev-key");
      await dialog
        .getByRole("button", {
          name: t("Test connection", "测试连接"),
          exact: true,
        })
        .click();
      await expect(
        page
          .locator('[data-slot="toast-title"]')
          .filter({ hasText: t("Connected to Jev", "已连接 Jev") }),
      ).toBeVisible();
      const measures = async (prefix) =>
        dialog.locator(`#${prefix}-url`).evaluate((el) => {
          const style = getComputedStyle(el);
          const field = el.closest('[data-slot="field"]');
          const label = field.querySelector('[data-slot="field-label"]');
          return {
            height: el.getBoundingClientRect().height,
            font: style.font,
            radius: style.borderRadius,
            padding: style.padding,
            labelFont: getComputedStyle(label).font,
            gap: getComputedStyle(field).gap,
          };
        });
      const jevStyle = await measures("jev");
      await page.screenshot({ path: info.outputPath("jev-settings.png") });
      await dialog
        .getByRole("button", { name: t("Save", "保存"), exact: true })
        .click();
      await expect(dialog).toBeHidden();
      await content
        .getByRole("button", {
          name: t("Manage Tavily", "管理 Tavily"),
          exact: true,
        })
        .click();
      const baseline = page.getByRole("dialog", {
        name: "Tavily",
        exact: true,
      });
      const tavilyStyle = await baseline
        .locator("#tavily-url")
        .evaluate((el) => {
          const style = getComputedStyle(el);
          const field = el.closest('[data-slot="field"]');
          return {
            height: el.getBoundingClientRect().height,
            font: style.font,
            radius: style.borderRadius,
            padding: style.padding,
            labelFont: getComputedStyle(
              field.querySelector('[data-slot="field-label"]'),
            ).font,
            gap: getComputedStyle(field).gap,
          };
        });
      expect(jevStyle).toEqual(tavilyStyle);
      await page.keyboard.press("Escape");
      await expect(baseline).toBeHidden();
      for (const name of ["Jev", "Tavily", "GitHub", "Jira", "Confluence"]) {
        const manage = content.getByRole("button", {
          name: `${t("Manage", "管理")} ${name}`,
          exact: true,
        });
        await manage.click();
        const settings = page.getByRole("dialog", { name, exact: true });
        await expect(settings.getByRole("switch")).toHaveCount(0);
        await expect(
          settings.getByRole("button", {
            name: t("Disconnect", "断开连接"),
            exact: true,
          }),
        ).toBeVisible();
        await page.keyboard.press("Escape");
      }
      for (const width of [1280, 850, 390]) {
        await page.setViewportSize({ width, height: 900 });
        expect(
          await content.evaluate((el) => el.scrollWidth <= el.clientWidth),
        ).toBe(true);
        await page.screenshot({
          path: info.outputPath(`connector-list-${width}.png`),
        });
        await content
          .getByRole("button", {
            name: t("Manage Jev", "管理 Jev"),
            exact: true,
          })
          .click();
        await expect(dialog.locator("#jev-token")).toHaveValue("");
        await expect(
          dialog.getByRole("button", { name: t("Save", "保存"), exact: true }),
        ).toBeDisabled();
        expect(
          await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth),
        ).toBe(true);
        await page.screenshot({
          path: info.outputPath(`jev-dialog-${width}.png`),
        });
        await page.keyboard.press("Escape");
      }
      expect(errors).toEqual([]);
    });

    test(`Jev consent stays in the conversation and can be revoked: ${language}, ${theme}`, async ({
      page,
    }, info) => {
      await mockJev(page, { language, theme, conversation: true });
      const t = (en, zh) => (language === "en" ? en : zh);
      await page.goto("/");
      await expect(
        page.getByRole("heading", { name: "Sample feedback", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", {
          name: t("Add attachment", "添加附件"),
          exact: true,
        }),
      ).toBeVisible();
      await expect(page.locator('[data-slot="jev-approval"]')).toHaveCount(0);
      await page.evaluate(() => window.jevFixtureRequest());
      const card = page.locator('[data-slot="jev-approval"]');
      await expect(card).toBeVisible();
      await expect(
        page.getByText(t("Waiting for your approval", "等待你确认"), {
          exact: true,
        }),
      ).toBeVisible();
      await page.screenshot({
        path: info.outputPath("jev-consent-collapsed.png"),
      });
      await card
        .getByRole("button", {
          name: t("View details", "查看发送内容"),
        })
        .click();
      await expect(card).toContainText(
        "The sample lamp arrived with a loose switch.",
      );
      await expect(card).toContainText("Product feedback");
      for (const width of [1280, 850, 390]) {
        if (width === 390)
          await page
            .getByRole("button", {
              name: t("Collapse sidebar", "折叠侧栏"),
              exact: true,
            })
            .click();
        await page.setViewportSize({ width, height: 900 });
        expect(
          await card.evaluate((el) => el.scrollWidth <= el.clientWidth),
        ).toBe(true);
        await page.screenshot({
          path: info.outputPath(`jev-consent-${width}.png`),
        });
      }
      await card
        .getByRole("button", {
          name: t("Allow", "允许"),
          exact: true,
        })
        .click();
      await expect(card).toHaveCount(0);
      await page.setViewportSize({ width: 1280, height: 900 });
      await page
        .getByRole("button", {
          name: t("Expand sidebar", "展开侧栏"),
          exact: true,
        })
        .click();
      const content = await openConnectors(page, language);
      await content
        .getByRole("button", { name: t("Manage Jev", "管理 Jev"), exact: true })
        .click();
      const dialog = page.getByRole("dialog", { name: "Jev", exact: true });
      await expect(
        dialog.getByText(t("Current conversation", "当前会话"), {
          exact: true,
        }),
      ).toHaveCount(0);
      await page.keyboard.press("Escape");
      await page
        .locator(".settings-navigation")
        .getByRole("button", { name: t("Back to app", "返回应用") })
        .click();
      await expect(page.locator('[data-slot="jev-usage"]')).toHaveCount(1);
      await page.locator('[data-slot="jev-usage"]').click();
      const details = page.locator('[data-slot="popover-content"]');
      await expect(details).toContainText('"product"');
      await page.screenshot({ path: info.outputPath("jev-usage.png") });
      await page.keyboard.press("Escape");
      await page.evaluate(() => window.jevFixtureRequest());
      await card
        .getByRole("button", {
          name: t("Disable for this chat", "本会话不用"),
          exact: true,
        })
        .click();
      await expect(card).toHaveCount(0);
      await page.evaluate(() => window.jevFixtureRequest());
      await expect(card).toHaveCount(0);
      await page.setViewportSize({ width: 1280, height: 900 });
      await page
        .getByRole("button", { name: "Other conversation", exact: true })
        .click();
      await page.evaluate(() => window.jevFixtureRequest("other-chat"));
      await expect(card).toHaveCount(1);
      expect(
        await page.evaluate(
          () =>
            window.calls.filter(({ name }) => name === "jevConsentReply")
              .length,
        ),
      ).toBe(2);
    });
  }

test("failed consent submission leaves the previous state available for retry", async ({
  page,
}) => {
  await mockJev(page, { conversation: true });
  await page.goto("/");
  await page.evaluate(() => {
    window.failJevReply = true;
    window.jevFixtureRequest();
  });
  const card = page.locator('[data-slot="jev-approval"]');
  await card.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(card).toBeVisible();
  await expect(
    card.getByRole("button", { name: "Allow", exact: true }),
  ).toBeEnabled();
  await page.evaluate(() => {
    window.failJevReply = false;
  });
  await card
    .getByRole("button", {
      name: "Disable for this chat",
      exact: true,
    })
    .click();
  await expect(card).toHaveCount(0);
});

for (const language of ["en", "zh"]) {
  test(`automatic chat permission is explicit, reversible and independent: ${language}`, async ({
    page,
  }, info) => {
    await mockJev(page, { language, conversation: true });
    const t = (en, zh) => (language === "en" ? en : zh);
    await page.goto("/");
    await page.evaluate(() => window.jevFixtureRequest());
    const card = page.locator('[data-slot="jev-approval"]');
    const checkbox = card.getByRole("checkbox", {
      name: t("Always allow in this chat", "本会话自动允许"),
      exact: true,
    });
    await expect(checkbox).not.toBeChecked();
    await expect(card).toHaveAccessibleName(
      t("Allow Jev to classify these items?", "允许 Jev 分类这些内容？"),
    );
    expect(
      await card.evaluate((el) => el.getBoundingClientRect().width),
    ).toBeLessThanOrEqual(576);
    await checkbox.focus();
    await page.keyboard.press("Space");
    await expect(card).toContainText(
      t(
        "Future content will be sent without asking.",
        "后续内容将直接发送，不再询问。",
      ),
    );
    await page.screenshot({ path: info.outputPath("jev-auto-consent.png") });
    await card
      .getByRole("button", { name: t("Allow", "允许"), exact: true })
      .click();
    const permission = page.locator('[data-slot="jev-session-access"]');
    await expect(permission).toContainText(
      t("Jev · Auto-allow", "Jev · 自动允许"),
    );
    const payload = await page.evaluate(
      () => window.calls.find(({ name }) => name === "jevConsentReply").input,
    );
    expect(payload).toMatchObject({ allow: true, autoAllow: true });
    await expect(page.locator('[data-slot="jev-usage"]')).toHaveCount(1);
    await page.evaluate(() => window.jevFixtureRequest());
    await expect(card).toHaveCount(0);
    await page
      .getByRole("button", { name: "Other conversation", exact: true })
      .click();
    await expect(permission).toHaveCount(0);
    await page.evaluate(() => window.jevFixtureRequest("other-chat"));
    await expect(card.getByRole("checkbox")).not.toBeChecked();
    await page
      .getByRole("button", { name: "Sample feedback", exact: true })
      .click();
    await permission.getByRole("button").click();
    await page
      .getByRole("menuitem", { name: t("Ask again", "恢复询问"), exact: true })
      .click();
    await expect(permission).toHaveCount(0);
    await page.evaluate(() => window.jevFixtureRequest());
    await expect(card).toBeVisible();
    await card
      .getByRole("button", {
        name: t("Disable for this chat", "本会话不用"),
        exact: true,
      })
      .click();
    await expect(permission).toContainText(
      t("Jev · Disabled", "Jev · 本会话停用"),
    );
    await expect(page.locator('[data-slot="jev-usage"]')).toHaveCount(0);
    await permission.getByRole("button").click();
    await page
      .getByRole("menuitem", { name: t("Ask again", "恢复询问"), exact: true })
      .click();
    await expect(permission).toHaveCount(0);
    await page.evaluate(() => window.jevFixtureFinish("error"));
    await expect(page.locator('[data-slot="jev-usage"]')).toHaveCount(0);
  });
}
