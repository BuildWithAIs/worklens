import { mockWorklens } from "./fixture.js";
import { test, expect } from "@playwright/test";

test("local paths stay compact and expose their full value on keyboard focus", async ({
  page,
}, info) => {
  await mockWorklens(page);
  await page.addInitScript(() => {
    const invoke = window.worklens.invoke;
    window.worklens.invoke = async (method, input) => {
      const result = await invoke(method, input);
      if (method === "bootstrap")
        result.paths.runtime =
          "/Users/example/Library/Application Support/WorkLens/long-directory-name/runtime";
      return result;
    };
  });
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const row = page
    .getByRole("listitem")
    .filter({ hasText: "Runtime directory" });
  const path = row.locator(".settings-path");
  const full = await path.textContent();
  await expect(path).toHaveCSS("white-space", "nowrap");
  expect(await path.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(
    true,
  );
  await page.keyboard.press("Tab");
  await page.mouse.move(0, 0);
  await path.focus();
  await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText(full);
  await row.getByRole("button", { name: "Open Runtime directory" }).focus();
  await expect(
    page
      .locator('[data-slot="tooltip-content"][data-open]')
      .filter({ hasText: full }),
  ).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("local-data-compact.png") });
});

test("settings and chat model workflow", async ({ page }, testInfo) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await mockWorklens(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Providers", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Providers", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator(".settings-navigation")
      .getByRole("button", { name: "Back to app" }),
  ).toBeVisible();
  const backButton = page
    .locator(".settings-navigation")
    .getByRole("button", { name: "Back to app" });
  await expect(page.locator(".sidebar")).toBeHidden();
  const settingsBounds = await page
    .locator(".settings-shell-dialog")
    .boundingBox();
  expect(settingsBounds).toMatchObject({
    x: 0,
    y: 0,
    width: 1280,
    height: 900,
  });
  await page.setViewportSize({ width: 1280, height: 600 });
  const headerBefore = await backButton.boundingBox();
  await page.locator(".settings-scroll").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  expect(
    await page.locator(".settings-scroll").evaluate((el) => el.scrollTop),
  ).toBeGreaterThan(0);
  await expect(backButton).toBeInViewport();
  expect((await backButton.boundingBox()).y).toBe(headerBefore.y);
  await page.screenshot({
    path: testInfo.outputPath("settings-scrolled-header.png"),
    animations: "disabled",
  });
  await page.locator(".settings-scroll").evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(
    page.getByRole("dialog", { name: "Settings", exact: true }),
  ).toBeVisible();
  expect(
    await page
      .locator('[data-slot="settings-section-title"]')
      .first()
      .evaluate((el) => getComputedStyle(el).fontSize),
  ).toBe("14px");
  expect(
    await page
      .locator('[data-slot="settings-section-title"]')
      .first()
      .evaluate((el) => getComputedStyle(el).fontWeight),
  ).toBe("500");
  await page.waitForTimeout(250);
  await page.screenshot({
    path: testInfo.outputPath("worklens-providers-v2.png"),
    animations: "disabled",
  });
  const search = page.getByRole("textbox", {
    name: "Search providers",
    exact: true,
  });
  const providerFilter = page.getByRole("combobox", {
    name: "Filter providers",
    exact: true,
  });
  await providerFilter.selectOption("connected");
  await expect(
    page.getByRole("heading", { name: "Available", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Connected", exact: true }),
  ).toBeVisible();
  await providerFilter.selectOption("available");
  await expect(
    page.getByRole("heading", { name: "Connected", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Available", exact: true }),
  ).toBeVisible();
  await search.fill("deep");
  const clearButton = page.getByRole("button", {
    name: "Clear search",
    exact: true,
  });
  const searchBounds = await search.boundingBox();
  const clearBounds = await clearButton.boundingBox();
  await clearButton.hover();
  await page.mouse.down();
  const pressedBounds = await clearButton.boundingBox();
  expect(Math.abs(pressedBounds.y - clearBounds.y)).toBeLessThanOrEqual(1.5);
  expect(pressedBounds.y).toBeGreaterThanOrEqual(searchBounds.y);
  expect(pressedBounds.y + pressedBounds.height).toBeLessThanOrEqual(
    searchBounds.y + searchBounds.height,
  );
  await page.mouse.up();
  await expect(search).toHaveValue("");
  await expect(search).toBeFocused();
  await search.fill("deep");
  await expect(
    page.getByText("No providers match your filters.", { exact: true }),
  ).toBeVisible();
  await providerFilter.selectOption("all");
  await search.clear();
  await search.fill("deep");
  await expect(page.locator(".settings-entry")).toHaveCount(1);
  await page
    .getByRole("button", { name: "Refresh providers", exact: true })
    .click();
  await expect(
    page.locator(
      '[data-slot="toast"]:not([data-ending-style]) [data-slot="toast-title"]',
    ),
  ).toContainText("Providers refreshed");
  await expect(page.getByText("STALE CONNECTION RESULT")).toHaveCount(0);
  await page.getByRole("button", { name: "Manage", exact: true }).click();
  await expect(
    page.getByRole("dialog").filter({
      hasNot: page.locator('[data-slot="toast-content"], .settings-workspace'),
    }),
  ).toHaveAccessibleName("DeepSeek");
  await expect(page.locator("input[type=password]")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeDisabled();
  await page.screenshot({
    path: testInfo.outputPath("provider-deepseek-form.png"),
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await search.fill("Azure");
  await expect(
    page.getByRole("button", { name: "Azure configuration", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Manage", exact: true }).click();
  await page
    .getByRole("switch", { name: "Update endpoint settings", exact: true })
    .check();
  await page
    .getByRole("textbox", { name: "Base URL", exact: true })
    .fill("https://example.openai.azure.com");
  await page.screenshot({
    path: testInfo.outputPath("provider-azure-form.png"),
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("dialog").filter({
      hasNot: page.locator('[data-slot="toast-content"], .settings-workspace'),
    }),
  ).toHaveCount(0);
  expect(
    (await page.evaluate(() => window.calls)).filter(
      (call) => call.name === "azure",
    ),
  ).toHaveLength(1);
  await search.fill("Bedrock");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(
    page.getByText("Managed through your system environment.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Continue", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await search.fill("GitHub");
  await page.getByRole("button", { name: "Manage", exact: true }).click();
  await expect(
    page.getByText("Current connection", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole("dialog")
      .filter({
        hasNot: page.locator(
          '[data-slot="toast-content"], .settings-workspace',
        ),
      })
      .getByRole("button", { name: "Disconnect", exact: true }),
  ).toHaveCount(1);
  await expect(page.getByRole("radio")).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("worklens-current-connection.png"),
    animations: "disabled",
  });

  await page
    .getByRole("combobox", { name: "Authentication", exact: true })
    .selectOption("oauth");
  await page.waitForTimeout(250);
  await page.screenshot({
    path: testInfo.outputPath("worklens-auth-v2.png"),
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "GitHub deployment" }),
  ).toBeVisible();
  await expect(
    page.getByText("Enter the device code in your browser to sign in.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("在浏览器中输入设备码完成登录", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("combobox", { name: "Authentication", exact: true })
    .selectOption("api_key");
  await expect(page.locator("input[type=password]")).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeDisabled();
  await page.locator("input[type=password]").fill("dummy-test-key");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("dialog").filter({
      hasNot: page.locator('[data-slot="toast-content"], .settings-workspace'),
    }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Models", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Models", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  const modelFilter = page.getByRole("combobox", { name: "Model filter" });
  await expect(modelFilter).toHaveValue("connected");
  const connectedGroupCount = await page
    .locator('[data-slot="accordion-item"]')
    .count();
  await modelFilter.selectOption("all");
  expect(
    await page.locator('[data-slot="accordion-item"]').count(),
  ).toBeGreaterThan(connectedGroupCount);
  await modelFilter.selectOption("connected");
  await page.waitForTimeout(250);
  await page.screenshot({
    path: testInfo.outputPath("worklens-models-v2.png"),
    animations: "disabled",
  });
  await page
    .getByRole("textbox", { name: "Search models", exact: true })
    .fill("DeepSeek");
  await expect(page.locator(".settings-entry")).toHaveCount(2);
  await page
    .getByRole("button", { name: "Refresh models: DeepSeek", exact: true })
    .click();
  await expect(
    page.locator(
      '[data-slot="toast"]:not([data-ending-style]) [data-slot="toast-title"]',
    ),
  ).toContainText("Models refreshed");
  if ((await page.evaluate(() => window.calls)).some((x) => x.name === "test"))
    throw Error("Refresh unexpectedly tested");
  await page
    .getByRole("button", {
      name: "Test connection: DeepSeek V4 Flash",
      exact: true,
    })
    .click();
  await expect(
    page.locator(
      '[data-slot="toast"]:not([data-ending-style]) [data-slot="toast-title"]',
    ),
  ).toHaveText("DeepSeek V4 Flash connection successful");
  await expect(page.locator(".model-test-result")).toHaveCount(0);
  await page
    .getByRole("switch", { name: "Show in chat: DeepSeek V4 Pro", exact: true })
    .uncheck();
  await expect(
    page.getByRole("switch", {
      name: "Show in chat: DeepSeek V4 Pro",
      exact: true,
    }),
  ).not.toBeChecked();
  await page
    .getByRole("textbox", { name: "Search models", exact: true })
    .fill("Copilot");
  const sonnet = page.getByRole("switch", {
    name: "Show in chat: Copilot Sonnet",
    exact: true,
  });
  const gemini = page.getByRole("switch", {
    name: "Show in chat: Copilot Gemini",
    exact: true,
  });
  const gpt = page.getByRole("switch", {
    name: "Show in chat: GPT-5",
    exact: true,
  });
  await sonnet.uncheck();
  await expect(gemini).toBeEnabled();
  await gemini.uncheck();
  await expect(sonnet).not.toBeChecked();
  await expect(gemini).not.toBeChecked();
  await expect(gpt).toBeChecked();
  await expect(gemini).toBeEnabled();
  await page.evaluate(() => {
    window.failNextVisibilitySave = true;
  });
  await sonnet.check();
  await gemini.check();
  await expect(sonnet).toBeEnabled();
  await expect(gemini).toBeEnabled();
  await expect(sonnet).not.toBeChecked();
  await expect(gemini).toBeChecked();
  await expect(gpt).toBeChecked();
  await page
    .locator('[data-slot="toast"]:not([data-ending-style])')
    .filter({ hasText: "Couldn’t save model visibility" })
    .locator('[data-slot="toast-close"]')
    .click();
  await gemini.uncheck();
  await expect(gemini).toBeEnabled();
  await page.screenshot({
    path: testInfo.outputPath("worklens-copilot-independent.png"),
    animations: "disabled",
  });
  await expect(page.getByText("Unavailable", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Configure", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Providers", exact: true }).click();
  await page.getByRole("button", { name: "Models", exact: true }).click();
  await expect(sonnet).not.toBeChecked();
  await expect(gpt).toBeChecked();
  await page.getByRole("button", { name: "Back to app", exact: true }).click();
  await page.getByRole("button", { name: "Choose model", exact: true }).click();
  expect(
    await page
      .locator(".chat-model-picker")
      .evaluate((el) => el.getBoundingClientRect().width),
  ).toBeLessThanOrEqual(320);

  await page
    .locator("[data-model-option]")
    .filter({ hasText: "GPT-5" })
    .click();
  await expect(
    page.getByRole("button", { name: "Thinking level", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Thinking level", exact: true })
    .click();
  await page.getByRole("radio", { name: "High", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Done", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Choose model", exact: true }),
  ).toContainText("GPT-5");
  await expect(
    page.getByRole("button", { name: "Choose model", exact: true }),
  ).toContainText("High");
  await expect(
    page.getByRole("button", { name: "Thinking level", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Choose model", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Search models", exact: true })
    .fill("DeepSeek");
  await expect(page.locator("[data-model-option]")).toHaveCount(1);
  await page.waitForTimeout(250);
  await page.screenshot({
    path: testInfo.outputPath("worklens-picker-v2.png"),
    animations: "disabled",
  });
  await page
    .getByRole("textbox", { name: "Search models", exact: true })
    .press("ArrowDown");
  await expect(page.locator("[data-model-option]").first()).toBeFocused();
  await page
    .getByRole("button", { name: "Manage models", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Models", exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Providers", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Search providers", exact: true })
    .fill("GitHub");
  await page.getByRole("button", { name: "Manage", exact: true }).click();
  await expect(
    page.getByText("Current connection", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole("dialog")
      .filter({
        hasNot: page.locator(
          '[data-slot="toast-content"], .settings-workspace',
        ),
      })
      .getByRole("button", { name: "Disconnect", exact: true }),
  ).toHaveCount(1);
  await expect(page.getByRole("radio")).toHaveCount(0);

  await page
    .getByRole("combobox", { name: "Authentication", exact: true })
    .selectOption("oauth");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page
    .getByRole("combobox", { name: "GitHub deployment" })
    .selectOption("public");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.getByRole("dialog").filter({
      hasNot: page.locator('[data-slot="toast-content"], .settings-workspace'),
    }),
  ).toHaveCount(0);
  await expect(page.locator(".settings-entry [data-slot=badge]")).toHaveText(
    "Sign in with GitHub",
  );
  const loginCount = (await page.evaluate(() => window.calls)).filter(
    (call) => call.name === "login",
  ).length;
  await page.getByRole("button", { name: "Manage", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "Authentication", exact: true }),
  ).toHaveValue("oauth");
  expect(
    (await page.evaluate(() => window.calls)).filter(
      (call) => call.name === "login",
    ),
  ).toHaveLength(loginCount);
  await page.screenshot({
    path: testInfo.outputPath("provider-copilot-form.png"),
    animations: "disabled",
  });
  await page
    .getByRole("dialog", { name: "GitHub Copilot", exact: true })
    .getByRole("button", { name: "Disconnect", exact: true })
    .click();
  const confirmation = page.getByRole("dialog", {
    name: "Disconnect GitHub Copilot?",
    exact: true,
  });
  await expect(confirmation).toContainText("Sign in with GitHub");
  await confirmation
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "GitHub Copilot", exact: true })
    .getByRole("button", { name: "Disconnect", exact: true })
    .click();
  await confirmation
    .getByRole("button", { name: "Disconnect", exact: true })
    .click();
  await expect(
    page.getByRole("dialog").filter({
      hasNot: page.locator('[data-slot="toast-content"], .settings-workspace'),
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Connect", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "General", exact: true }).click();
  const localDataInfo = page.getByRole("button", {
    name: "About local data",
    exact: true,
  });
  await page.keyboard.press("Tab");
  await localDataInfo.focus();
  await expect(page.locator('[data-slot="tooltip-content"]')).toBeVisible();
  await expect(page.locator('[data-slot="tooltip-content"]')).toContainText(
    "Conversation history and encrypted credentials are stored on this device.",
  );
  await page.keyboard.press("Escape");
  await expect(page.locator(".settings-hint")).toHaveCount(0);
  await page
    .getByRole("combobox", { name: "Language", exact: true })
    .selectOption("zh");
  await expect(
    page.getByRole("heading", { name: "通用", exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "通用", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "语言", exact: true }),
  ).toHaveValue("zh");
  await page
    .getByRole("combobox", { name: "语言", exact: true })
    .selectOption("en");
  await page
    .getByRole("combobox", { name: "Appearance", exact: true })
    .selectOption("dark");
  await expect(
    page.locator(
      '[data-slot="toast"]:not([data-ending-style]) [data-slot="toast-title"]',
    ),
  ).toHaveCount(0);
  await page.waitForTimeout(250);
  await page.screenshot({
    path: testInfo.outputPath("worklens-general-dark-v2.png"),
    animations: "disabled",
  });
  await page.setViewportSize({ width: 850, height: 760 });
  await page.getByRole("button", { name: "Providers", exact: true }).click();
  await page.waitForTimeout(250);
  await page.screenshot({
    path: testInfo.outputPath("worklens-narrow-v2.png"),
    animations: "disabled",
  });
  if (
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  )
    throw Error("Horizontal overflow");
  expect(errors).toEqual([]);
  console.log(
    "PASS: search, refresh isolation, exclusive auth, cancellation, masked input, model testing, visibility, picker, navigation, locale persistence, theme, narrow viewport, no JS errors",
  );
});
