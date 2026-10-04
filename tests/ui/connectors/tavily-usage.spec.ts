import { test, expect, type Page } from "@playwright/test";
import { mockWorklens } from "../fixture.js";

async function setup(page: Page, language = "en", theme = "light") {
  await mockWorklens(page);
  await page.addInitScript(
    ({ language, theme }) => {
      localStorage.setItem("worklens.language", language);
      const probe = {
        calls: 0,
        fail: false,
        held: false,
        release: undefined as undefined | (() => void),
        value: { plan: "Free", included: { used: 56, limit: 1000 } } as any,
        override: undefined as any,
        last: undefined as any,
      };
      (window as any).usageProbe = probe;
      const invoke = window.worklens.invoke;
      window.worklens.invoke = (async (method: string, input: any) => {
        if (method === "tavilyTest") return "Tavily 已连接：Free";
        if (method === "tavilyUsage") {
          probe.calls++;
          if (probe.held)
            await new Promise<void>((resolve) => {
              probe.release = resolve;
            });
          if (probe.fail) throw new Error("Synthetic quota read failure");
          const result = probe.override ?? {
            usage: {
              ...structuredClone(probe.value),
              fetchedAt: Date.now(),
              expiresAt: Date.now() + 300_000,
            },
            refreshAfter: Date.now() + 60_000,
          };
          probe.last = structuredClone(result);
          return result;
        }
        const result = await (invoke as any)(method, input);
        if (method === "bootstrap") {
          result.settings.theme = theme;
          result.tavily = {
            url: "https://api.tavily.test",
            configured: true,
            plan: "Free",
          };
        }
        return result;
      }) as typeof window.worklens.invoke;
    },
    { language, theme },
  );
  await page.goto("/");
  await page
    .getByRole("button", {
      name: language === "en" ? "Settings" : "设置",
      exact: true,
    })
    .click();
  await page
    .locator(".settings-navigation")
    .getByRole("button", {
      name: language === "en" ? "Connectors" : "连接器",
      exact: true,
    })
    .click();
  return page.getByRole("button", {
    name: language === "en" ? "Manage Tavily" : "管理 Tavily",
    exact: true,
  });
}

for (const language of ["en", "zh"])
  for (const theme of ["light", "dark"])
    test(`compact credits and optional paid allowance: ${language}, ${theme}`, async ({
      page,
    }, info) => {
      const manage = await setup(page, language, theme);
      await manage.click();
      const dialog = page.getByRole("dialog", { name: "Tavily", exact: true });
      await expect(
        dialog.getByText("56 / 1,000 Credits", { exact: true }),
      ).toBeVisible();
      await expect(dialog.getByRole("meter", { name: "Free" })).toHaveAttribute(
        "aria-valuenow",
        "56",
      );
      await expect(dialog.getByRole("meter")).toHaveCount(1);
      await expect(
        dialog.getByRole("button", { name: /refresh|刷新/i }),
      ).toBeDisabled();
      await expect(dialog.getByRole("status")).toContainText(
        language === "en" ? "Updated" : "上次更新于",
      );
      const bar = dialog.getByRole("meter").locator("span");
      expect(
        await bar.evaluate(
          (el) =>
            el.getBoundingClientRect().width /
            el.parentElement!.getBoundingClientRect().width,
        ),
      ).toBeCloseTo(0.056, 2);
      await expect(dialog.getByRole("meter")).toHaveCSS("height", "8px");
      await page.screenshot({ path: info.outputPath("free-credits.png") });
      await page.keyboard.press("Escape");
      await page.evaluate(() => {
        (window as any).usageProbe.value.paygo = { used: 20, limit: 100 };
      });
      await manage.click();
      await expect(
        dialog.getByText("20 / 100 Credits", { exact: true }),
      ).toBeVisible();
      await expect(dialog.getByRole("meter")).toHaveCount(2);
      expect(await page.evaluate(() => (window as any).usageProbe.calls)).toBe(
        2,
      );
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 800 });
        expect(
          await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth),
        ).toBe(true);
        const height = await dialog
          .locator(".tavily-credit-usage")
          .evaluate((el) => el.getBoundingClientRect().height);
        // Includes the compact timestamp/refresh row below the two credit bars.
        expect(height).toBeLessThanOrEqual(112);
        await page.screenshot({
          path: info.outputPath(`paid-credits-${width}.png`),
        });
      }
      // Editing credentials hides the saved account's quota without sending a request using the draft.
      await dialog.locator("#tavily-token").fill("synthetic-other-key");
      await expect(dialog.locator(".tavily-credit-usage")).toHaveCount(0);
      expect(await page.evaluate(() => (window as any).usageProbe.calls)).toBe(
        2,
      );
    });

test("a failed usage read is retryable and does not lock or disconnect settings", async ({
  page,
}) => {
  await page.clock.install();
  const manage = await setup(page);
  await page.evaluate(() => {
    (window as any).usageProbe.fail = true;
  });
  await manage.click();
  const dialog = page.getByRole("dialog", { name: "Tavily", exact: true });
  await expect(dialog.getByRole("status")).toHaveText("Couldn’t load usage");
  await expect(dialog.locator("#tavily-url")).toBeEnabled();
  await expect(
    dialog.getByRole("button", { name: "Test connection", exact: true }),
  ).toBeEnabled();
  await page.evaluate(() => {
    (window as any).usageProbe.fail = false;
  });
  await expect(
    dialog.getByRole("button", { name: "Refresh usage", exact: true }),
  ).toBeDisabled();
  await page.clock.fastForward(60_001);
  await expect(
    dialog.getByText("56 / 1,000 Credits", { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByRole("status")).toContainText("Updated");
  await expect(dialog.getByRole("status")).not.toContainText("Couldn’t");
});

test("unknown or exceeded limits are honest and pending reads do not outlive the dialog", async ({
  page,
}) => {
  const manage = await setup(page);
  await page.evaluate(() => {
    const probe = (window as any).usageProbe;
    probe.value = {
      plan: "Free",
      included: { used: 1050, limit: 1000 },
      paygo: { used: 20, limit: null },
    };
    probe.held = true;
  });
  await manage.click();
  let dialog = page.getByRole("dialog", { name: "Tavily", exact: true });
  await expect(dialog.locator(".tavily-credit-usage")).toHaveAttribute(
    "aria-busy",
    "true",
  );
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await page.evaluate(() => {
    const probe = (window as any).usageProbe;
    probe.release();
    probe.held = false;
  });
  await manage.click();
  dialog = page.getByRole("dialog", { name: "Tavily", exact: true });
  await expect(
    dialog.getByText("1,050 / 1,000 Credits", { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByRole("meter", { name: "Free" })).toHaveAttribute(
    "aria-valuenow",
    "1000",
  );
  await expect(
    dialog.getByText("20 / — Credits", { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByRole("meter")).toHaveCount(1);
});

for (const language of ["en", "zh"])
  test(`Tavily rate limit toast follows ${language}`, async ({
    page,
  }, info) => {
    const manage = await setup(page, language);
    await page.evaluate(() => {
      const invoke = window.worklens.invoke;
      window.worklens.invoke = (async (method, input) => {
        if (method === "tavilyTest") throw new Error("Tavily 要求稍后重试");
        return invoke(method, input);
      }) as typeof window.worklens.invoke;
    });
    await manage.click();
    const dialog = page.getByRole("dialog", { name: "Tavily", exact: true });
    await dialog
      .getByRole("button", {
        name: language === "en" ? "Test connection" : "测试连接",
        exact: true,
      })
      .click();
    await expect(page.locator('[data-slot="toast-title"]')).toHaveText(
      language === "en" ? "Couldn’t connect to Tavily" : "无法连接 Tavily",
    );
    await expect(page.locator('[data-slot="toast-description"]')).toHaveText(
      language === "en"
        ? "Too many requests. Try again later."
        : "请求过于频繁，请稍后重试。",
    );
    await page.screenshot({ path: info.outputPath("rate-limit-toast.png") });
  });

test("an open dialog updates after cache expiry and stops polling after closing", async ({
  page,
}) => {
  await page.clock.install();
  const manage = await setup(page);
  await manage.click();
  const dialog = page.getByRole("dialog", { name: "Tavily", exact: true });
  await expect(
    dialog.getByText("56 / 1,000 Credits", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    (window as any).usageProbe.value.included.used = 62;
  });
  await page.clock.fastForward(299_000);
  await expect(
    dialog.getByText("56 / 1,000 Credits", { exact: true }),
  ).toBeVisible();
  await page.clock.fastForward(1001);
  await expect(
    dialog.getByText("62 / 1,000 Credits", { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => (window as any).usageProbe.calls)).toBe(2);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await page.clock.fastForward(600_000);
  expect(await page.evaluate(() => (window as any).usageProbe.calls)).toBe(2);
});

test("manual refresh and connection tests update visible credits without reopening", async ({
  page,
}) => {
  await page.clock.install();
  const manage = await setup(page);
  await manage.click();
  const dialog = page.getByRole("dialog", { name: "Tavily", exact: true });
  const refresh = dialog.getByRole("button", {
    name: "Refresh usage",
    exact: true,
  });
  await expect(
    dialog.getByText("56 / 1,000 Credits", { exact: true }),
  ).toBeVisible();
  await expect(refresh).toBeDisabled();
  await page.evaluate(() => {
    (window as any).usageProbe.value.included.used = 62;
  });
  await page.clock.fastForward(60_001);
  await expect(refresh).toBeEnabled();
  await refresh.click();
  await expect(
    dialog.getByText("62 / 1,000 Credits", { exact: true }),
  ).toBeVisible();
  await expect(refresh).toBeDisabled();
  await page.evaluate(() => {
    (window as any).usageProbe.value.included.used = 68;
  });
  await dialog
    .getByRole("button", { name: "Test connection", exact: true })
    .click();
  await expect(
    dialog.getByText("68 / 1,000 Credits", { exact: true }),
  ).toBeVisible();
});

test("a rate-limited connection test updates the visible usage cooldown", async ({
  page,
}) => {
  await page.clock.install();
  const manage = await setup(page);
  await manage.click();
  const dialog = page.getByRole("dialog", { name: "Tavily", exact: true });
  const refresh = dialog.getByRole("button", {
    name: "Refresh usage",
    exact: true,
  });
  await expect(
    dialog.getByText("56 / 1,000 Credits", { exact: true }),
  ).toBeVisible();
  const previous = await dialog.getByRole("status").textContent();
  await page.clock.fastForward(60_001);
  await expect(refresh).toBeEnabled();
  await page.evaluate(() => {
    const invoke = window.worklens.invoke;
    window.worklens.invoke = (async (method, input) => {
      if (method === "tavilyTest") {
        const probe = (window as any).usageProbe;
        probe.override = {
          usage: probe.last.usage,
          refreshAfter: Date.now() + 600_000,
          error: "rate_limit",
        };
        throw new Error("Tavily 要求稍后重试");
      }
      return invoke(method, input);
    }) as typeof window.worklens.invoke;
  });
  await dialog
    .getByRole("button", { name: "Test connection", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText(
    "Usage temporarily rate limited",
  );
  await expect(dialog.getByRole("status")).toContainText(previous!);
  await expect(refresh).toBeDisabled();
  expect(await page.evaluate(() => (window as any).usageProbe.calls)).toBe(2);
  await page.clock.fastForward(300_000);
  await expect(refresh).toBeDisabled();
  expect(await page.evaluate(() => (window as any).usageProbe.calls)).toBe(2);
});

test("rate-limited refresh retains the old timestamp and disables refresh until the server deadline", async ({
  page,
}, info) => {
  await page.clock.install();
  const manage = await setup(page);
  await manage.click();
  const dialog = page.getByRole("dialog", { name: "Tavily", exact: true });
  await expect(
    dialog.getByText("56 / 1,000 Credits", { exact: true }),
  ).toBeVisible();
  const previous = await dialog.getByRole("status").textContent();
  await page.clock.fastForward(60_001);
  await page.evaluate(() => {
    const probe = (window as any).usageProbe;
    probe.override = {
      usage: probe.last.usage,
      refreshAfter: Date.now() + 600_000,
      error: "rate_limit",
    };
  });
  const refresh = dialog.getByRole("button", {
    name: "Refresh usage",
    exact: true,
  });
  await refresh.click();
  await expect(dialog.getByRole("status")).toContainText(
    "Usage temporarily rate limited",
  );
  await expect(dialog.getByRole("status")).toContainText(previous!);
  await expect(
    dialog.getByText("56 / 1,000 Credits", { exact: true }),
  ).toBeVisible();
  await expect(refresh).toBeDisabled();
  await page.clock.fastForward(300_000);
  expect(await page.evaluate(() => (window as any).usageProbe.calls)).toBe(2);
  await expect(refresh).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 800 });
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: info.outputPath("cached-usage-rate-limit.png"),
  });
});

test("expired usage waits while hidden and updates when the dialog becomes visible", async ({
  page,
}) => {
  await page.clock.install();
  const manage = await setup(page);
  await manage.click();
  const dialog = page.getByRole("dialog", { name: "Tavily", exact: true });
  await expect(
    dialog.getByText("56 / 1,000 Credits", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    (window as any).usageProbe.value.included.used = 62;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.fastForward(600_000);
  expect(await page.evaluate(() => (window as any).usageProbe.calls)).toBe(1);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(
    dialog.getByText("62 / 1,000 Credits", { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => (window as any).usageProbe.calls)).toBe(2);
});
