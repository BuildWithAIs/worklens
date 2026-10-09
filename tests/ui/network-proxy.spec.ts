import { test, expect, type Page } from "@playwright/test";
import { mockWorklens } from "./fixture.js";

async function openGeneral(
  page: Page,
  detection: Record<string, string> = {},
  shell?: Record<string, string>,
  language = "en",
) {
  await mockWorklens(page);
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
  await expect(row.getByRole("status")).toHaveText(
    "Using http://127.0.0.1:7890",
  );
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

  await address.fill("127.0.0.1:1087");
  await dialog.getByLabel("Bypass proxy for").fill("internal.example");
  await dialog.getByRole("button", { name: "Test connection" }).click();
  const toast = page.locator('[data-slot="toast"]').filter({
    hasText: "Proxy connection successful",
  });
  await expect(toast).toContainText("Connected through http://127.0.0.1:1087");
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
      url: "http://127.0.0.1:1087",
      bypass: "internal.example",
    },
  ]);
  await expect(select).toHaveValue("custom");
  await expect(row.getByRole("status")).toHaveText(
    "Using http://127.0.0.1:1087",
  );

  await row.getByRole("button", { name: "Edit custom proxy" }).click();
  await expect(address).toHaveValue("http://127.0.0.1:1087");
  await expect(dialog.locator("#network-proxy-url-hint")).toHaveCount(0);
  await page.evaluate(() => {
    (window as any).failProxyTest = true;
  });
  await dialog.getByRole("button", { name: "Test connection" }).click();
  await expect(
    page.locator('[data-slot="toast"]').filter({
      hasText: "Couldn’t connect through the proxy",
    }),
  ).toBeVisible();
});

test("turning the proxy off saves immediately", async ({
  page,
}) => {
  const row = await openGeneral(page);
  await expect(row.getByRole("status")).toHaveText(
    "No system proxy detected. Requests connect directly.",
  );
  await row.getByRole("combobox", { name: "Proxy" }).selectOption("off");
  await expect(row.getByRole("status")).toHaveText(
    "Requests connect directly.",
  );
  expect(await settingsCalls(page)).toEqual([{ mode: "off" }]);
});

test("custom proxy falls back to the login shell and reports unsupported system proxies", async ({
  page,
}) => {
  const row = await openGeneral(
    page,
    { unsupported: "SOCKS5 127.0.0.1:7891" },
    { environment: "http://127.0.0.1:1087" },
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
    "http://127.0.0.1:1087",
  );
  await expect(dialog.locator("#network-proxy-url-hint")).toHaveText(
    "已从 shell 环境变量中填入。",
  );
});
