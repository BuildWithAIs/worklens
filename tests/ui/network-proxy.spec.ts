import { test, expect, type Page } from "@playwright/test";
import { mockWorklens } from "./fixture.js";

async function openGeneral(
  page: Page,
  detection: Record<string, string> = {},
  shell?: Record<string, string>,
  language = "en",
  connectorError = false,
  initialSettings?: Partial<import("../../src/shared/contracts").Settings>,
) {
  await mockWorklens(page, { connectorError, initialSettings });
  await page.addInitScript(
    ({ detection, shell, language }) => {
      localStorage.setItem("worklens.language", language);
      (window as any).proxyDetection = detection;
      (window as any).proxyShellDetection = shell;
    },
    { detection, shell, language },
  );
  await page.goto("/");
  await page
    .getByRole("button", {
      name: language === "en" ? "Settings" : "设置",
      exact: true,
    })
    .click();
  return page.locator("[data-network-proxy]");
}

async function settingsCalls(page: Page) {
  return page.evaluate(() =>
    (window as any).calls
      .filter((call: any) => call.name === "settings" && call.input.proxy)
      .map((call: any) => call.input.proxy),
  );
}

test("network proxy follows the detected system proxy by default", async ({
  page,
}, info) => {
  const row = await openGeneral(page, { system: "http://127.0.0.1:7890" });
  await expect(
    page.getByRole("heading", { name: "Network", exact: true }),
  ).toBeVisible();
  await expect(row.getByRole("combobox", { name: "Proxy" })).toHaveValue(
    "system",
  );
  await expect(row.getByRole("status")).toHaveText("http://127.0.0.1:7890");
  await row.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("network-system.png") });
});

test("custom proxy is prefilled, validated, tested and applied only after saving", async ({
  page,
}, info) => {
  const row = await openGeneral(page, { system: "http://127.0.0.1:7890" });
  const select = row.getByRole("combobox", { name: "Proxy" });
  await select.selectOption("custom");
  const dialog = page.getByRole("dialog", { name: "Custom proxy" });
  const address = dialog.getByLabel("Proxy address");
  await expect(address).toHaveValue("http://127.0.0.1:7890");
  await expect(dialog.locator("#network-proxy-url-hint")).toHaveText(
    "Filled in from your system proxy.",
  );
  await page.screenshot({ path: info.outputPath("network-custom-dialog.png") });

  // Cancelling keeps the saved mode.
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(select).toHaveValue("system");
  expect(await settingsCalls(page)).toEqual([]);

  await select.selectOption("custom");
  await address.fill("socks5://127.0.0.1:7891");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.locator("#network-proxy-url-error")).toHaveText(
    "Enter an HTTP or HTTPS proxy address, such as http://127.0.0.1:7890.",
  );
  await expect(address).toBeFocused();
  await expect(dialog.locator("#network-proxy-url-hint")).toHaveCount(0);

  await address.fill("127.0.0.1:9080");
  await dialog
    .getByLabel("Bypass proxy for")
    .fill("internal.example, 192.0.2.0/24");
  await expect(dialog.locator("#network-proxy-bypass-hint")).toContainText(
    "CIDR ranges",
  );
  await dialog.getByRole("button", { name: "Test connection" }).click();
  const toast = page.locator('[data-slot="toast"]').filter({
    hasText: "Proxy connection successful",
  });
  await expect(toast).toContainText("Connected through http://127.0.0.1:9080");
  expect(await settingsCalls(page)).toEqual([]);

  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.locator('[data-slot="toast"]').filter({
      hasText: "Proxy settings saved",
    }),
  ).toBeVisible();
  expect(await settingsCalls(page)).toEqual([
    {
      mode: "custom",
      url: "http://127.0.0.1:9080",
      bypass: "internal.example, 192.0.2.0/24",
    },
  ]);
  await expect(select).toHaveValue("custom");
  await expect(row.getByRole("status")).toHaveText("http://127.0.0.1:9080");

  // The edit button matches the select beside it.
  const edit = row.getByRole("button", { name: "Edit custom proxy" });
  const heights = await Promise.all(
    [edit, select].map((control) =>
      control.evaluate((element) => element.getBoundingClientRect().height),
    ),
  );
  expect(heights[0]).toBe(heights[1]);
  await row.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("network-custom-row.png") });
  await edit.click();
  await expect(address).toHaveValue("http://127.0.0.1:9080");
  await expect(dialog.locator("#network-proxy-url-hint")).toHaveCount(0);
  await page.evaluate(() => {
    (window as any).failProxyTest = true;
  });
  await dialog.getByRole("button", { name: "Test connection" }).click();
  // The dialog explains the failure itself, without a second toast.
  await expect(dialog.getByRole("alert")).toHaveText(
    "Couldn’t complete the connection test. Check the proxy address and your network.",
  );
  await expect(
    page.locator('[data-slot="toast"]').filter({ hasText: "connection test" }),
  ).toHaveCount(0);
  await dialog.getByLabel("Bypass proxy for").fill("*");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Test connection" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "Couldn’t complete the connection test. Check your network.",
  );
});

test("runtime network warnings deduplicate, persist in settings and clear on recovery", async ({
  page,
}, info) => {
  const row = await openGeneral(
    page,
    { system: "http://127.0.0.1:7890" },
    undefined,
    "en",
    true,
  );
  await page.getByRole("button", { name: "Back to app" }).click();
  await expect(row).toHaveCount(0);
  const emit = (revision: number, proxy: boolean, bypass: boolean) =>
    page.evaluate((status) => (window as any).emitNetworkStatus(status), {
      revision,
      proxy,
      bypass,
    });
  await emit(1, false, true);
  const notification = page
    .locator('[data-slot="toast"]')
    .filter({ hasText: "Some network requests failed" });
  await expect(notification).toHaveCount(1);
  await expect(notification).toContainText("Check your network");
  // A warning, not an error: requests may still succeed elsewhere.
  await expect(notification.locator("svg.lucide-triangle-alert")).toHaveCount(
    1,
  );
  const toastLayout = await notification.evaluate((element) => {
    const title = element.querySelector('[data-slot="toast-title"]')!;
    const description = element
      .querySelector('[data-slot="toast-description"]')!
      .getBoundingClientRect();
    const action = element
      .querySelector('[data-slot="toast-action"]')!
      .getBoundingClientRect();
    return {
      titleHeight: title.getBoundingClientRect().height,
      titleLineHeight: Number.parseFloat(getComputedStyle(title).lineHeight),
      descriptionWidth: description.width,
      actionTop: action.top,
      descriptionBottom: description.bottom,
    };
  });
  expect(toastLayout.titleHeight).toBeLessThanOrEqual(
    toastLayout.titleLineHeight + 1,
  );
  expect(toastLayout.descriptionWidth).toBeGreaterThan(200);
  expect(toastLayout.actionTop).toBeGreaterThan(toastLayout.descriptionBottom);
  await emit(2, false, true);
  await emit(1, false, false); // Stale snapshot/event cannot erase a newer warning.
  await expect(notification).toHaveCount(1);
  await notification.locator('[data-slot="toast-close"]').click();
  await expect(notification).not.toBeVisible();
  await emit(3, true, true);
  await expect(notification).not.toBeVisible();
  await emit(4, false, false);
  await emit(5, true, false);
  await expect(notification).toBeVisible();
  await notification.locator('[data-slot="toast-action"]').click();
  await expect(row).toBeVisible();
  await expect(notification).not.toBeVisible();
  const warning = row.locator("#network-proxy-warning");
  await expect(warning).toContainText("Proxy requests failed");
  // Seen in settings, the warning is not repeated as a notification.
  await emit(6, false, false);
  await expect(warning).toHaveCount(0);
  await emit(7, false, true);
  await expect(warning).toContainText("Direct requests failed");
  await emit(8, true, true);
  await expect(warning).toContainText("Proxy and direct requests failed");
  await page.getByRole("button", { name: "Back to app" }).click();
  await expect(notification).toHaveCount(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await row.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath("network-warning.png"),
  });
  const measures = async (locator: import("@playwright/test").Locator) =>
    locator.evaluate((element) => {
      const style = getComputedStyle(element);
      const icon = element.querySelector("svg")!.getBoundingClientRect();
      const content = getComputedStyle(element.parentElement!);
      return {
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        lineHeight: style.lineHeight,
        color: style.color,
        iconWidth: icon.width,
        iconHeight: icon.height,
        gap: content.gap,
      };
    });
  const networkMeasures = await measures(warning);
  await page.getByRole("button", { name: "Connectors", exact: true }).click();
  const connectorWarning = page.locator(
    '[data-connection="jira"] [role="status"]',
  );
  await expect(connectorWarning).toBeVisible();
  expect(await measures(connectorWarning)).toEqual(networkMeasures);
});

test("a runtime warning offers a connection test for the system proxy", async ({
  page,
}) => {
  const row = await openGeneral(page, { system: "http://127.0.0.1:7890" });
  await page.evaluate(() =>
    (window as any).emitNetworkStatus({
      revision: 1,
      proxy: true,
      bypass: false,
    }),
  );
  const warning = row.locator("#network-proxy-warning");
  const test = warning.getByRole("button", { name: "Test connection" });
  await test.click();
  await expect(
    page
      .locator('[data-slot="toast"]')
      .filter({ hasText: "Connection successful" }),
  ).toBeVisible();
  await expect(warning).toContainText("Proxy requests failed");
  expect(
    await page.evaluate(() =>
      (window as any).calls
        .filter((call: any) => call.name === "proxyTest")
        .map((call: any) => call.input),
    ),
  ).toEqual([{ mode: "system" }]);
  await page.evaluate(() => ((window as any).failProxyTest = true));
  await test.click();
  await expect(warning).toContainText(
    "Couldn’t complete the connection test. Check your network.",
  );
  // A newer status replaces the result of a test run before it.
  await page.evaluate(() =>
    (window as any).emitNetworkStatus({
      revision: 2,
      proxy: true,
      bypass: true,
    }),
  );
  await expect(warning).toContainText("Proxy and direct requests failed");
});

for (const language of ["en", "zh"] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`custom proxy warning fits beside both controls in ${language}, ${theme}`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width: 850, height: 620 });
      const row = await openGeneral(page, {}, undefined, language, false, {
        theme,
        proxy: {
          mode: "custom",
          url: "http://127.0.0.1:9080",
          bypass: "private.example.test, 192.0.2.0/24",
        },
      });
      await page.evaluate(() =>
        (window as any).emitNetworkStatus({
          revision: 1,
          proxy: true,
          bypass: true,
        }),
      );
      await row.scrollIntoViewIfNeeded();
      const warning = row.locator("#network-proxy-warning");
      await expect(warning).toBeVisible();
      // The open settings page shows the warning, so no notification repeats it,
      // and a custom proxy is tested from its dialog rather than the row.
      await expect(page.locator('[data-slot="toast"]')).toHaveCount(0);
      await expect(warning.getByRole("button")).toHaveCount(0);
      const layout = await warning.evaluate((element) => ({
        height: element.getBoundingClientRect().height,
        lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
      }));
      expect(layout.height).toBeLessThanOrEqual(layout.lineHeight + 1);
      await expect(
        row.getByRole("button", {
          name: language === "en" ? "Edit custom proxy" : "编辑自定义代理",
        }),
      ).toBeVisible();
      await expect(row.getByRole("combobox")).toBeVisible();
      await page.screenshot({
        path: info.outputPath(`custom-proxy-warning-${language}-${theme}.png`),
      });
    });
  }
}

// Holds connection tests until the test fails them, as a slow network would.
async function holdProxyTests(page: Page) {
  await page.evaluate(() => {
    const worklens = (window as any).worklens;
    const invoke = worklens.invoke;
    worklens.invoke = async (name: string, input: any) => {
      if (name !== "proxyTest") return invoke(name, input);
      await new Promise((resolve) => ((window as any).releaseTest = resolve));
      setTimeout(() => ((window as any).testSettled = true));
      throw Error("Could not reach the network through proxy http://held");
    };
  });
}

test("a connection test that outlives its settings cannot restore a warning", async ({
  page,
}) => {
  const row = await openGeneral(page, { system: "http://127.0.0.1:7890" });
  await holdProxyTests(page);
  await page.evaluate(() =>
    (window as any).emitNetworkStatus({
      revision: 1,
      proxy: true,
      bypass: false,
    }),
  );
  const warning = row.locator("#network-proxy-warning");
  await warning.getByRole("button", { name: "Test connection" }).click();
  const select = row.getByRole("combobox", { name: "Proxy" });
  await select.selectOption("off");
  await expect(select).toHaveValue("off");
  await page.evaluate(() =>
    (window as any).emitNetworkStatus({
      revision: 2,
      proxy: false,
      bypass: false,
    }),
  );
  await expect(warning).toHaveCount(0);
  await page.evaluate(() => (window as any).releaseTest());
  await page.waitForFunction(() => (window as any).testSettled);
  // Let React commit whatever the finished test set, then check once.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  expect(await warning.count()).toBe(0);
});

test("Chinese runtime warnings fit the settings row at the minimum window width", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 850, height: 620 });
  const row = await openGeneral(page, {}, undefined, "zh");
  await page.evaluate(() =>
    (window as any).emitNetworkStatus({
      revision: 1,
      proxy: true,
      bypass: true,
    }),
  );
  await row.scrollIntoViewIfNeeded();
  await expect(row.locator("#network-proxy-warning")).toContainText(
    "代理和直连请求均失败",
  );
  const fits = await row.evaluate(
    (element) => element.scrollWidth <= element.clientWidth,
  );
  expect(fits).toBe(true);
  await page.screenshot({
    path: info.outputPath("network-warning-zh-narrow.png"),
  });
  const warningHeight = await row
    .locator("#network-proxy-warning")
    .evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
    }));
  expect(warningHeight.height).toBeLessThanOrEqual(
    warningHeight.lineHeight + 1,
  );
});

test("turning the proxy off saves immediately", async ({ page }) => {
  const row = await openGeneral(page);
  await expect(row.getByRole("status")).toHaveText(
    "No system proxy detected. Requests connect directly.",
  );
  await row.getByRole("combobox", { name: "Proxy" }).selectOption("off");
  await expect(row.getByRole("status")).toHaveCount(0);
  await expect(row.getByRole("combobox", { name: "Proxy" })).toHaveValue("off");
  expect(await settingsCalls(page)).toEqual([{ mode: "off" }]);
});

test("custom proxy falls back to the login shell and reports unsupported system proxies", async ({
  page,
}) => {
  const row = await openGeneral(
    page,
    { unsupported: "SOCKS5 127.0.0.1:7891" },
    { environment: "http://127.0.0.1:9080" },
    "zh",
  );
  await expect(
    page.getByRole("heading", { name: "网络", exact: true }),
  ).toBeVisible();
  await expect(row.getByRole("status")).toHaveText(
    "系统代理使用 SOCKS，暂不支持，请求将直接连接。",
  );
  await row.getByRole("combobox", { name: "代理" }).selectOption("custom");
  const dialog = page.getByRole("dialog", { name: "自定义代理" });
  await expect(dialog.getByLabel("代理地址")).toHaveValue(
    "http://127.0.0.1:9080",
  );
  await expect(dialog.locator("#network-proxy-url-hint")).toHaveText(
    "已从 shell 环境变量中填入。",
  );
  await expect(dialog.locator("#network-proxy-bypass-hint")).toContainText(
    "域名解析后的 IP",
  );
});

test("a bypassed connection test reports direct access without claiming the proxy was tested", async ({
  page,
}) => {
  const row = await openGeneral(page, { system: "http://127.0.0.1:7890" });
  await row.getByRole("combobox", { name: "Proxy" }).selectOption("custom");
  const dialog = page.getByRole("dialog", { name: "Custom proxy" });
  await dialog.getByLabel("Bypass proxy for").fill("*");
  await dialog.getByRole("button", { name: "Test connection" }).click();
  const notification = page
    .locator('[data-slot="toast"]')
    .filter({ hasText: "Connection successful" });
  await expect(notification).toContainText(
    "Connected directly to the network test address.",
  );
  await expect(notification).not.toContainText("Connected through");
  expect(await settingsCalls(page)).toEqual([]);
});
