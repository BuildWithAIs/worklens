import { test, expect, type Page, type Locator } from "@playwright/test";
import { mockWorklens } from "./fixture.js";
import type { Requests } from "../../src/shared/contracts";

async function mockMcp(
  page: Page,
  options: {
    connections?: Record<string, Record<string, unknown>>;
    theme?: string;
    language?: string;
  } = {},
) {
  await mockWorklens(page);
  await page.addInitScript(
    ({ connections = {}, theme = "light", language = "en" }) => {
      localStorage.setItem("worklens.language", language);
      const state = window as any;
      const invoke = window.worklens.invoke;
      let config = { mcpServers: connections };
      const signedIn = new Set<string>();
      const snapshot = () => {
        const masked = structuredClone(config);
        for (const entry of Object.values(masked.mcpServers)) {
          for (const field of ["headers", "env"])
            for (const key of Object.keys((entry[field] as object) ?? {}))
              (entry[field] as Record<string, string>)[key] = "<saved>";
        }
        for (const entry of Object.values(masked.mcpServers)) {
          if ((entry.oauth as any)?.clientSecret)
            (entry.oauth as any).clientSecret = "<saved>";
        }
        return {
          config: JSON.stringify(masked, null, 2),
          servers: Object.entries(config.mcpServers).map(([name, entry]) => ({
            name,
            transport: entry.url ? "http" : "stdio",
            enabled: entry.enabled !== false,
            exposure: entry.exposure ?? "codemode",
            oauth:
              !!entry.url &&
              !entry.auth &&
              !Object.keys((entry.headers as object) ?? {}).some(
                (key) => key.toLowerCase() === "authorization",
              ),
            signedIn: signedIn.has(name),
          })),
        };
      };
      state.mcpSnapshot = snapshot;
      state.mcpTestCount = 3;
      window.worklens.invoke = (async (name: keyof Requests, input: any) => {
        if (name === "bootstrap") {
          if (state.failBootstrap) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            throw Error("Fixture refresh failure");
          }
          const result = await invoke(name, input);
          result.settings.theme = theme as any;
          result.mcp = snapshot() as any;
          return result;
        }
        if (name.startsWith("mcp")) state.calls.push({ name, input });
        if (name === "mcpSave") {
          await new Promise((resolve) => setTimeout(resolve, 120));
          if (state.failMcpSave) throw Error("Fixture save failure");
          const next = JSON.parse(input.config);
          if (!next.mcpServers || Array.isArray(next.mcpServers))
            throw Error("Invalid MCP configuration");
          for (const [id, value] of Object.entries(next.mcpServers)) {
            const entry = value as any;
            const old = config.mcpServers[id] as any;
            const sameTarget =
              old &&
              (entry.url
                ? old.url && new URL(old.url).href === new URL(entry.url).href
                : !old.url &&
                  JSON.stringify([old.command, old.args, old.cwd]) ===
                    JSON.stringify([entry.command, entry.args, entry.cwd]));
            const field = entry.url ? "headers" : "env";
            for (const [key, value] of Object.entries(entry[field] ?? {})) {
              if (value !== "<saved>") continue;
              if (!sameTarget || !Object.hasOwn(old[field] ?? {}, key))
                throw Error("Re-enter credentials after changing the server");
              entry[field][key] = old[field][key];
            }
            if (entry.oauth?.clientSecret === "<saved>") {
              if (
                !sameTarget ||
                !old.oauth?.clientSecret ||
                old.oauth.clientId !== entry.oauth.clientId
              )
                throw Error("Re-enter the OAuth client secret");
              entry.oauth.clientSecret = old.oauth.clientSecret;
            }
          }
          config = next;
          return snapshot();
        }
        if (name === "mcpTest") {
          await new Promise((resolve) => setTimeout(resolve, 120));
          if (state.failMcpTest) throw Error("Fixture connection failure");
          return { tools: state.mcpTestCount };
        }
        if (name === "mcpLogin" || name === "mcpLogout") {
          const target = new URL(config.mcpServers[input.name].url as string)
            .href;
          for (const [id, entry] of Object.entries(config.mcpServers)) {
            if (entry.url && new URL(entry.url as string).href === target) {
              if (name === "mcpLogin") signedIn.add(id);
              else signedIn.delete(id);
            }
          }
          return snapshot();
        }
        if (
          name === "settings" &&
          input?.codemodeEnabled !== undefined &&
          state.failCodeMode
        ) {
          await new Promise((resolve) => setTimeout(resolve, 120));
          throw Error("Fixture settings failure");
        }
        const result = await invoke(name, input);
        // Keep the fixture's chosen theme when settings returns a fresh object.
        if (name === "settings") return { ...(result as object), theme };
        return result;
      }) as typeof window.worklens.invoke;
    },
    options,
  );
}

async function selectMcp(page: Page, language = "en") {
  await page
    .locator(".settings-navigation")
    .getByRole("button", {
      name: language === "en" ? "Connectors" : "连接器",
      exact: true,
    })
    .click();
  await page.getByRole("tab", { name: "MCP", exact: true }).click();
}
async function openMcp(page: Page, language = "en") {
  await page.goto("/");
  await page
    .getByRole("button", {
      name: language === "en" ? "Settings" : "设置",
      exact: true,
    })
    .click();
  await selectMcp(page, language);
  return page.locator("[data-mcp-settings]");
}
async function saved(page: Page) {
  return page.evaluate(
    () => JSON.parse((window as any).mcpSnapshot().config).mcpServers,
  );
}
async function manage(page: Page, name: string, language = "en") {
  const label =
    language === "en" ? `Manage connection: ${name}` : `管理连接：${name}`;
  await page.getByRole("button", { name: label, exact: true }).click();
  return page.getByRole("dialog", {
    name: label,
    exact: true,
  });
}

async function expectSavedEditor(editor: Locator, language = "en") {
  await expect(editor).toBeVisible();
  await expect(
    editor.getByRole("button", {
      name: language === "en" ? "Save" : "保存",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    editor.getByRole("button", {
      name: language === "en" ? "Test connection" : "测试连接",
      exact: true,
    }),
  ).toBeEnabled();
}

async function testSavedConnection(page: Page, name: string, language = "en") {
  const editor = await manage(page, name, language);
  const testButton = editor.getByRole("button", {
    name: language === "en" ? "Test connection" : "测试连接",
    exact: true,
  });
  await testButton.click();
  await expect(testButton).toBeEnabled();
  await editor
    .getByRole("button", {
      name: language === "en" ? "Close" : "关闭",
      exact: true,
    })
    .click();
  await expect(editor).not.toBeVisible();
}

for (const theme of ["light", "dark"])
  for (const language of ["en", "zh"]) {
    test(`MCP first-use, dialog and multiple connections: ${theme}, ${language}`, async ({
      page,
    }, info) => {
      await mockMcp(page, { theme, language });
      const section = await openMcp(page, language);
      const add = language === "en" ? "Add connection" : "添加连接";
      const nameLabel = language === "en" ? "Connection name" : "连接名称";
      const urlLabel =
        language === "en" ? "MCP server address" : "MCP 服务地址";
      const saveLabel = language === "en" ? "Save" : "保存";
      await expect(section.locator("#mcp-config")).not.toBeVisible();
      await expect(section.locator("summary")).toHaveCount(0);
      await expect(
        section.getByRole("button", { name: saveLabel, exact: true }),
      ).toHaveCount(0);
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await expect(
          section.getByRole("button", { name: add, exact: true }),
        ).toBeVisible();
        expect(
          await section.evaluate((el) => el.scrollWidth <= el.clientWidth),
        ).toBe(true);
        await page.screenshot({ path: info.outputPath(`empty-${width}.png`) });
      }
      await page.setViewportSize({ width: 1280, height: 900 });
      await section.getByRole("button", { name: add, exact: true }).focus();
      await page.keyboard.press("Enter");
      const editor = page.getByRole("dialog", { name: add, exact: true });
      await expect(
        editor.getByRole("textbox", { name: nameLabel, exact: true }),
      ).toBeFocused();
      await editor
        .getByRole("textbox", { name: nameLabel, exact: true })
        .fill("company-jira");
      await editor
        .getByRole("textbox", { name: urlLabel, exact: true })
        .fill("https://example.invalid/jira/mcp");
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        expect(
          await editor.evaluate((el) => el.scrollWidth <= el.clientWidth),
        ).toBe(true);
        await page.screenshot({ path: info.outputPath(`dialog-${width}.png`) });
      }
      await editor.getByRole("button", { name: add, exact: true }).click();
      await expect(editor).not.toBeVisible();
      await section.getByRole("button", { name: add, exact: true }).click();
      await editor
        .getByRole("textbox", { name: nameLabel, exact: true })
        .fill("team-confluence");
      await editor
        .getByRole("textbox", { name: urlLabel, exact: true })
        .fill("https://example.invalid/confluence/mcp");
      await editor.getByRole("button", { name: add, exact: true }).click();
      await expect(editor).not.toBeVisible();
      await expect(section.locator("[data-mcp-connection]")).toHaveCount(2);
      await expect(
        section.locator("[data-mcp-connection]").first(),
      ).toContainText("company-jira");
      await expect(
        section.locator("[data-mcp-connection]").last(),
      ).toContainText("team-confluence");
      await expect(
        section.getByRole("button", { name: add, exact: true }),
      ).toBeVisible();
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        expect(
          await section.evaluate((el) => el.scrollWidth <= el.clientWidth),
        ).toBe(true);
        await page.screenshot({
          path: info.outputPath(`connections-${width}.png`),
        });
      }
      await page.setViewportSize({ width: 1280, height: 900 });
      await expect(
        section.getByRole("switch", { name: "Code Mode", exact: true }),
      ).toHaveCount(0);
      await page
        .locator(".settings-navigation")
        .getByRole("button", {
          name: language === "en" ? "General" : "通用",
          exact: true,
        })
        .click();
      const toggle = page.getByRole("switch", {
        name: "Code Mode",
        exact: true,
      });
      await expect(toggle).toBeChecked();
      await toggle.uncheck();
      await expect(toggle).toBeEnabled();
      await expect(toggle).not.toBeChecked();
      await selectMcp(page, language);
      await expect(section.locator("[data-mcp-connection]")).toHaveCount(2);
      await expect(
        section.getByRole("heading", {
          name: language === "en" ? "Connected" : "已连接",
          exact: true,
        }),
      ).toBeVisible();
      await section.getByRole("button", { name: add, exact: true }).focus();
      await page.keyboard.press("Enter");
      await editor
        .getByRole("tab", {
          name: language === "en" ? "Manual setup" : "手动配置",
          exact: true,
        })
        .focus();
      await page.keyboard.press("ArrowRight");
      await expect(
        editor.getByRole("tab", {
          name: language === "en" ? "Import JSON" : "导入 JSON",
          exact: true,
        }),
      ).toHaveAttribute("aria-selected", "true");
      const importLabel = language === "en" ? "Import connections" : "导入连接";
      await expect(
        editor.getByRole("button", { name: importLabel, exact: true }),
      ).toBeDisabled();
      await editor.locator("#mcp-import").fill(
        JSON.stringify(
          {
            mcpServers: {
              "local-files": { command: "node", args: ["mcp-server.mjs"] },
            },
          },
          null,
          2,
        ),
      );
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        expect(
          await editor.evaluate((el) => el.scrollWidth <= el.clientWidth),
        ).toBe(true);
        await page.screenshot({
          path: info.outputPath(`json-dialog-${width}.png`),
        });
      }
      await page.keyboard.press("Escape");
      await expect(editor).not.toBeVisible();
      await expect(
        section.getByRole("button", { name: add, exact: true }),
      ).toBeFocused();
    });
  }

for (const theme of ["light", "dark"])
  for (const language of ["en", "zh"])
    test(`MCP form replaces hints with concise errors: ${theme}, ${language}`, async ({
      page,
    }, info) => {
      await mockMcp(page, { theme, language });
      await page.setViewportSize({ width: 1280, height: 800 });
      const section = await openMcp(page, language);
      const add = language === "en" ? "Add connection" : "添加连接";
      await section.getByRole("button", { name: add, exact: true }).click();
      const editor = page.getByRole("dialog", { name: add, exact: true });
      const name = editor.locator("#mcp-name");
      await expect(editor.locator("#mcp-name-hint")).toBeVisible();
      await expect(name).toBeFocused();
      await editor.locator("#mcp-url").focus();
      await expect(editor.locator("#mcp-name-error")).toHaveText(
        language === "en" ? "Enter a connection name." : "请输入连接名称。",
      );
      await expect(editor.locator("#mcp-name-hint")).toHaveCount(0);
      await expect(name).toHaveAttribute("aria-describedby", "mcp-name-error");
      await name.fill("invalid name");
      await editor.locator("#mcp-url").focus();
      await expect(editor.locator("#mcp-name-error")).toContainText("1–80");
      await expect(editor.locator("#mcp-name-hint")).toHaveCount(0);
      await editor.locator("#mcp-url").fill("https://example.invalid/mcp");
      await editor.locator("summary").click();
      await expect(editor.getByText(/Keep <saved>|保留 <saved>/)).toHaveCount(
        0,
      );
      await page.screenshot({ path: info.outputPath("expanded-error.png") });
      await name.fill("company-jira");
      await expect(editor.locator("#mcp-name-hint")).toBeVisible();
      await expect(name).toHaveAttribute("aria-describedby", "mcp-name-hint");
      await expect(editor.locator("#mcp-name-error")).toHaveCount(0);
      await page.screenshot({ path: info.outputPath("expanded-ready.png") });
      await editor
        .getByRole("button", { name: add, exact: true })
        .scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath("expanded-footer.png") });
    });

test("MCP close button dismisses manual and JSON drafts over native drag regions", async ({
  page,
}) => {
  await mockMcp(page);
  const section = await openMcp(page);
  await page.evaluate(() => {
    document.documentElement.dataset.nativeVibrancy = "true";
  });
  await expect(page.locator(".settings-page-heading")).toHaveCSS(
    "-webkit-app-region",
    "drag",
  );
  const add = section.getByRole("button", {
    name: "Add connection",
    exact: true,
  });
  const editor = page.getByRole("dialog", {
    name: "Add connection",
    exact: true,
  });
  for (const method of ["Manual setup", "Import JSON"]) {
    await add.click();
    await expect(editor).toHaveCSS("-webkit-app-region", "no-drag");
    await editor.getByRole("tab", { name: method, exact: true }).click();
    if (method === "Manual setup") {
      await editor.locator("#mcp-name").fill("invalid name");
      await editor.locator("#mcp-url").focus();
      await expect(editor.locator("#mcp-name-error")).toBeVisible();
    } else {
      await editor.locator("#mcp-import").fill('{"mcpServers":');
    }
    await editor.getByRole("button", { name: "Close", exact: true }).click();
    await expect(editor).not.toBeVisible();
    await expect(add).toBeFocused();
  }
  expect(await saved(page)).toEqual({});
  expect(
    await page.evaluate(() =>
      (window as any).calls.filter((call: any) => call.name === "mcpSave"),
    ),
  ).toHaveLength(0);
});

test("MCP editing preserves other connections and advanced settings; cancel never saves", async ({
  page,
}) => {
  const original = {
    company_jira: {
      type: "streamable-http",
      url: "https://example.invalid/mcp?api_key=synthetic-query",
      headers: { Authorization: "synthetic-token", "X-Team": "team" },
      exposure: "deferred",
      toolExposure: { update_issue: "hidden" },
      timeout: 20,
    },
    local: {
      command: "node",
      args: ["", "embedded\nargument"],
      env: { TOKEN: "synthetic-env" },
      cwd: "/tmp/worklens",
    },
  };
  await mockMcp(page, { connections: original });
  const section = await openMcp(page);
  await expect(
    section.locator("[data-mcp-connection]").first(),
  ).not.toContainText("synthetic-query");
  const before = await saved(page);
  let editor = await manage(page, "company_jira");
  await expect(editor.locator("#mcp-name")).toHaveAttribute("readonly", "");
  await editor
    .getByRole("switch", {
      name: "Enable connection",
      exact: true,
    })
    .uncheck();
  await expect(
    editor.getByRole("button", { name: "Test connection", exact: true }),
  ).toBeDisabled();
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await saved(page)).toEqual(before);
  editor = await manage(page, "company_jira");
  await editor
    .getByRole("switch", {
      name: "Enable connection",
      exact: true,
    })
    .uncheck();
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expectSavedEditor(editor);
  await editor.getByRole("button", { name: "Close", exact: true }).click();
  await expect(editor).not.toBeVisible();
  const next = await saved(page);
  expect(next.local).toEqual(before.local);
  expect(next.company_jira).toEqual({ ...before.company_jira, enabled: false });
  editor = await manage(page, "local");
  await editor
    .getByRole("switch", {
      name: "Enable connection",
      exact: true,
    })
    .uncheck();
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expectSavedEditor(editor);
  await editor.getByRole("button", { name: "Close", exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect((await saved(page)).local).toEqual({
    ...before.local,
    enabled: false,
  });
});

test("MCP validates names, namespaces, addresses and JSON beside their fields", async ({
  page,
}) => {
  await mockMcp(page, {
    connections: { company_jira: { url: "https://example.invalid/mcp" } },
  });
  const section = await openMcp(page);
  await section
    .getByRole("button", { name: "Add connection", exact: true })
    .click();
  const editor = page.getByRole("dialog", {
    name: "Add connection",
    exact: true,
  });
  const name = editor.locator("#mcp-name");
  await name.fill("公司 Jira");
  await editor.locator("#mcp-url").fill("http://example.invalid/mcp");
  await expect(editor.locator("#mcp-name-error")).toBeVisible();
  await editor
    .getByRole("button", { name: "Add connection", exact: true })
    .click();
  await expect(name).toBeFocused();
  await expect(editor.locator("#mcp-url-error")).toBeVisible();
  await name.fill("company-jira");
  await editor.locator("#mcp-url").fill("https://example.invalid/mcp");
  await expect(editor.locator("#mcp-name-error")).toHaveText(/already in use/);
  await name.fill("another-jira");
  await editor.locator("summary").click();
  await editor.locator("#mcp-options").fill('{"headers":');
  await editor
    .getByRole("button", { name: "Add connection", exact: true })
    .click();
  await expect(editor.locator("#mcp-options-error")).toBeVisible();
  await expect(editor.locator("#mcp-options")).toBeFocused();
  expect(Object.keys(await saved(page))).toEqual(["company_jira"]);
});

test("MCP local setup and connection test feedback", async ({ page }) => {
  await mockMcp(page);
  const section = await openMcp(page);
  await section
    .getByRole("button", { name: "Add connection", exact: true })
    .click();
  const editor = page.getByRole("dialog", {
    name: "Add connection",
    exact: true,
  });
  await editor.locator("#mcp-name").fill("local-files");
  await editor.locator("#mcp-transport").selectOption("stdio");
  await editor.locator("#mcp-command").fill("npx");
  await editor.locator("#mcp-args").fill("-y\nexample-mcp\n/tmp/My Files");
  await editor
    .getByRole("button", { name: "Add connection", exact: true })
    .click();
  await expect(editor).not.toBeVisible();
  expect((await saved(page))["local-files"]).toEqual({
    command: "npx",
    args: ["-y", "example-mcp", "/tmp/My Files"],
    enabled: true,
  });
  const row = section.locator("[data-mcp-connection]");
  await expect(row.getByRole("status")).toHaveCount(0);
  await testSavedConnection(page, "local-files");
  await expect(row.getByRole("status")).toHaveText(
    "Last test passed · 3 tools available",
  );
  await page.evaluate(() => {
    (window as any).failMcpTest = true;
  });
  await testSavedConnection(page, "local-files");
  await expect(
    page.locator('[data-slot="toast"]').filter({ hasText: "Couldn’t connect" }),
  ).toContainText("Couldn’t connect");
  await expect(row.getByRole("status")).toHaveCount(0);
});

test("MCP JSON import preserves existing connections, drafts and failed submissions", async ({
  page,
}) => {
  await mockMcp(page, {
    connections: {
      company_jira: {
        url: "https://example.invalid/mcp",
        headers: { Authorization: "synthetic-token" },
      },
    },
  });
  const section = await openMcp(page);
  const before = await saved(page);
  const button = section.getByRole("button", {
    name: "Add connection",
    exact: true,
  });
  const editor = page.getByRole("dialog", {
    name: "Add connection",
    exact: true,
  });
  const draft = JSON.stringify(
    {
      mcpServers: {
        "team-confluence": {
          url: "https://example.invalid/confluence/mcp",
          headers: { Authorization: "synthetic-import-token" },
        },
        local_files: {
          command: "node",
          args: ["", "embedded\nargument"],
          env: { TOKEN: "synthetic-env" },
        },
      },
    },
    null,
    2,
  );
  await button.click();
  await editor.locator("#mcp-name").fill("manual-draft");
  await editor.getByRole("tab", { name: "Import JSON", exact: true }).click();
  await editor.locator("#mcp-import").fill(draft);
  await editor.getByRole("tab", { name: "Manual setup", exact: true }).click();
  await expect(editor.locator("#mcp-name")).toHaveValue("manual-draft");
  await editor.getByRole("tab", { name: "Import JSON", exact: true }).click();
  await expect(editor.locator("#mcp-import")).toHaveValue(draft);
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect(await saved(page)).toEqual(before);
  expect(
    await page.evaluate(() =>
      (window as any).calls.filter((call: any) => call.name === "mcpSave"),
    ),
  ).toHaveLength(0);
  await button.click();
  await editor.getByRole("tab", { name: "Import JSON", exact: true }).click();
  await expect(editor.locator("#mcp-import")).toHaveValue("");
  await editor.locator("#mcp-import").fill(draft);
  await page.evaluate(() => {
    (window as any).failMcpSave = true;
  });
  await editor
    .getByRole("button", { name: "Import connections", exact: true })
    .click();
  await expect(
    page
      .locator('[data-slot="toast"]')
      .filter({ hasText: "Couldn’t update MCP settings" }),
  ).toContainText("Couldn’t update MCP settings");
  await expect(editor.locator("#mcp-import")).toHaveValue(draft);
  expect(await saved(page)).toEqual(before);
  await page.evaluate(() => {
    (window as any).failMcpSave = false;
  });
  await editor
    .getByRole("button", { name: "Import connections", exact: true })
    .click();
  await expect(editor).not.toBeVisible();
  const next = await saved(page);
  expect(next.company_jira).toEqual(before.company_jira);
  expect(next["team-confluence"].url).toBe(
    "https://example.invalid/confluence/mcp",
  );
  expect(next["team-confluence"].headers.Authorization).toBe("<saved>");
  expect(next.local_files.args).toEqual(["", "embedded\nargument"]);
  expect(next.local_files.env.TOKEN).toBe("<saved>");
  await expect(section.locator("[data-mcp-connection]")).toHaveCount(3);
});

test("MCP JSON import rejects invalid names and namespace conflicts before saving", async ({
  page,
}) => {
  await mockMcp(page, {
    connections: { company_jira: { url: "https://example.invalid/mcp" } },
  });
  const section = await openMcp(page);
  const before = await saved(page);
  await section
    .getByRole("button", { name: "Add connection", exact: true })
    .click();
  const editor = page.getByRole("dialog", {
    name: "Add connection",
    exact: true,
  });
  await editor.getByRole("tab", { name: "Import JSON", exact: true }).click();
  const input = editor.locator("#mcp-import");
  const submit = editor.getByRole("button", {
    name: "Import connections",
    exact: true,
  });
  const cases: [string, RegExp][] = [
    ['{"mcpServers":', /valid JSON/],
    [JSON.stringify({ mcpServers: {} }), /at least one connection/],
    [
      JSON.stringify({ mcpServers: { "公司-jira": { command: "node" } } }),
      /1–80 letters/,
    ],
    [
      JSON.stringify({ mcpServers: { "company-jira": { command: "node" } } }),
      /already in use/,
    ],
    [
      JSON.stringify({
        mcpServers: {
          "new-name": { command: "node" },
          new_name: { command: "node" },
        },
      }),
      /already in use/,
    ],
    [
      JSON.stringify({
        mcpServers: Object.fromEntries(
          Array.from({ length: 100 }, (_, index) => [
            `local-${index}`,
            { command: "node" },
          ]),
        ),
      }),
      /up to 100/,
    ],
  ];
  for (const [configuration, message] of cases) {
    await input.fill(configuration);
    await submit.click();
    await expect(editor.locator("#mcp-import-error")).toHaveText(message);
    await expect(input).toBeFocused();
  }
  expect(await saved(page)).toEqual(before);
  expect(
    await page.evaluate(() =>
      (window as any).calls.filter((call: any) => call.name === "mcpSave"),
    ),
  ).toHaveLength(0);
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(editor).not.toBeVisible();
});

test("MCP deletion is confirmed, failure stays visible, and other connections remain", async ({
  page,
}) => {
  await mockMcp(page, {
    connections: {
      jira: { url: "https://example.invalid/mcp" },
      confluence: { url: "https://example.invalid/wiki" },
    },
  });
  const section = await openMcp(page);
  const editor = await manage(page, "jira");
  await editor.getByRole("button", { name: "Delete", exact: true }).click();
  const confirmation = page.getByRole("dialog", {
    name: "Delete jira?",
    exact: true,
  });
  await expect(
    confirmation.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();
  await confirmation
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  expect(Object.keys(await saved(page))).toEqual(["jira", "confluence"]);
  await editor.getByRole("button", { name: "Delete", exact: true }).click();
  await page.evaluate(() => {
    (window as any).failMcpSave = true;
  });
  await confirmation
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(
    page
      .locator('[data-slot="toast"]')
      .filter({ hasText: "Couldn’t update MCP settings" }),
  ).toContainText("Couldn’t update MCP settings");
  await page.evaluate(() => {
    (window as any).failMcpSave = false;
  });
  await confirmation
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(editor).not.toBeVisible();
  await expect(section.locator("[data-mcp-connection]")).toHaveCount(1);
  expect(Object.keys(await saved(page))).toEqual(["confluence"]);
  expect(
    await page.evaluate(() =>
      (window as any).calls.filter((call: any) => call.name === "mcpLogout"),
    ),
  ).toEqual([]);
});

test("MCP token changes clear previous test feedback without changing custom headers", async ({
  page,
}) => {
  await mockMcp(page, {
    connections: {
      jira: {
        url: "https://example.invalid/mcp",
        headers: {
          authorization: "synthetic-old-token",
          "X-Team": "synthetic-team",
        },
      },
    },
  });
  const section = await openMcp(page);
  const row = section.locator("[data-mcp-connection]");
  await testSavedConnection(page, "jira");
  await expect(row.getByRole("status")).toBeVisible();
  const editor = await manage(page, "jira");
  await editor.locator("#mcp-token").fill("Bearer synthetic-new-token");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expectSavedEditor(editor);
  await editor.getByRole("button", { name: "Close", exact: true }).click();
  await expect(editor).not.toBeVisible();
  await expect(row.getByRole("status")).toHaveCount(0);
  const payload = await page.evaluate(() => {
    const calls = (window as any).calls.filter(
      (call: any) => call.name === "mcpSave",
    );
    return JSON.parse(calls.at(-1).input.config).mcpServers.jira;
  });
  expect(payload.headers).toEqual({
    "X-Team": "<saved>",
    authorization: "Bearer synthetic-new-token",
  });
});

test("Code Mode keeps its row stable while saving and restores the saved value on failure", async ({
  page,
}) => {
  await mockMcp(page);
  await page.addInitScript(() => {
    const invoke = window.worklens.invoke;
    window.worklens.invoke = (async (name, input) => {
      if (
        name === "settings" &&
        (input as Requests["settings"]["input"])?.codemodeEnabled !== undefined
      ) {
        await new Promise<void>((resolve) => {
          (window as any).finishCodeModeSave = resolve;
        });
      }
      return invoke(name, input);
    }) as typeof window.worklens.invoke;
  });
  await openMcp(page);
  await page
    .locator(".settings-navigation")
    .getByRole("button", { name: "General", exact: true })
    .click();
  const section = page.locator('[data-section="general"]');
  await page.evaluate(() => {
    (window as any).failCodeMode = true;
  });
  const toggle = section.getByRole("switch", {
    name: "Code Mode",
    exact: true,
  });
  const row = toggle.locator('xpath=ancestor::*[@data-slot="item"]');
  const before = await row.boundingBox();
  await toggle.uncheck();
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeDisabled();
  await expect(toggle).toHaveAttribute("aria-busy", "true");
  await expect(toggle).toHaveCSS("cursor", "default");
  expect(
    await toggle.evaluate(
      (element) => getComputedStyle(element, "::after").cursor,
    ),
  ).toBe("default");
  await expect(row.getByRole("status")).toHaveCount(0);
  await expect(row).not.toContainText("Saving");
  expect((await row.boundingBox())?.height).toBe(before?.height);
  await page.evaluate(() => (window as any).finishCodeModeSave());
  await expect(
    page
      .locator('[data-slot="toast"]')
      .filter({ hasText: "Couldn’t save Code Mode" }),
  ).toBeVisible();
  await expect(section.getByRole("alert")).toHaveCount(0);
  await expect(toggle).toBeChecked();
  await expect(toggle).toBeEnabled();
  await expect(toggle).toHaveAttribute("aria-busy", "false");
  expect((await row.boundingBox())?.height).toBe(before?.height);
});

test("MCP keeps committed connections when bootstrap is unavailable, including after leaving settings", async ({
  page,
}) => {
  await mockMcp(page);
  await openMcp(page);
  await page.evaluate(() => {
    (window as any).failBootstrap = true;
  });
  for (const name of ["first", "second"]) {
    await page
      .getByRole("button", { name: "Add connection", exact: true })
      .click();
    const editor = page.getByRole("dialog", {
      name: "Add connection",
      exact: true,
    });
    await editor.locator("#mcp-name").fill(name);
    await editor.locator("#mcp-url").fill(`https://example.invalid/${name}`);
    await editor
      .getByRole("button", { name: "Add connection", exact: true })
      .click();
    await expect(editor).not.toBeVisible();
    await page
      .locator(".settings-navigation")
      .getByRole("button", { name: "General", exact: true })
      .click();
    await selectMcp(page);
    await expect(
      page.getByRole("button", {
        name: `Manage connection: ${name}`,
        exact: true,
      }),
    ).toBeVisible();
  }
  expect(Object.keys(await saved(page))).toEqual(["first", "second"]);
});

test("Code Mode retains a successful save when bootstrap is unavailable", async ({
  page,
}) => {
  await mockMcp(page);
  await openMcp(page);
  await page
    .locator(".settings-navigation")
    .getByRole("button", { name: "General", exact: true })
    .click();
  await page.evaluate(() => {
    (window as any).failBootstrap = true;
  });
  const toggle = page.getByRole("switch", { name: "Code Mode", exact: true });
  await toggle.uncheck();
  await expect(toggle).toBeEnabled();
  await expect(toggle).not.toBeChecked();
  await selectMcp(page);
  await page
    .locator(".settings-navigation")
    .getByRole("button", { name: "General", exact: true })
    .click();
  await expect(toggle).not.toBeChecked();
});

test("MCP rejects duplicate Authorization editing instead of silently overwriting it", async ({
  page,
}) => {
  await mockMcp(page);
  await openMcp(page);
  await page
    .getByRole("button", { name: "Add connection", exact: true })
    .click();
  const editor = page.getByRole("dialog", {
    name: "Add connection",
    exact: true,
  });
  await editor.locator("#mcp-name").fill("jira");
  await editor.locator("#mcp-url").fill("https://example.invalid/mcp");
  await editor.locator("#mcp-token").fill("Bearer synthetic-token");
  await editor.getByText("Advanced", { exact: true }).click();
  await editor.locator("#mcp-options").fill(
    JSON.stringify({
      headers: { authorization: "Basic synthetic-custom-value" },
    }),
  );
  await editor
    .getByRole("button", { name: "Add connection", exact: true })
    .click();
  await expect(editor.locator("#mcp-options-error")).toContainText(
    "Edit Authorization in the field above",
  );
  expect(Object.keys(await saved(page))).toHaveLength(0);
  await editor.locator("#mcp-options").fill("{}");
  await editor.locator("#mcp-token").fill("Basic synthetic-custom-value");
  await editor
    .getByRole("button", { name: "Add connection", exact: true })
    .click();
  await expect(editor).not.toBeVisible();
  const authorization = await page.evaluate(() => {
    const calls = (window as any).calls.filter(
      (call: any) => call.name === "mcpSave",
    );
    return JSON.parse(calls.at(-1).input.config).mcpServers.jira.headers
      .Authorization;
  });
  expect(authorization).toBe("Basic synthetic-custom-value");
});

test("MCP identifies every credential that needs re-entry after changing an address", async ({
  page,
}) => {
  await mockMcp(page, {
    connections: {
      jira: {
        url: "https://example.invalid/old",
        headers: {
          authorization: "Bearer synthetic-old",
          "X-Workspace": "synthetic-workspace",
        },
        oauth: { clientId: "client", clientSecret: "synthetic-secret" },
      },
    },
  });
  await openMcp(page);
  const editor = await manage(page, "jira");
  await editor.locator("summary").click();
  await expect(
    editor.getByText(/Keep <saved> to reuse credentials/),
  ).toBeVisible();
  await editor.locator("#mcp-url").fill("https://example.invalid/new");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor.locator("#mcp-token-error")).toContainText(
    "server address changed",
  );
  await expect(editor.locator("#mcp-token")).toBeFocused();
  await expect(editor.locator("#mcp-options-error")).toContainText(
    "headers.X-Workspace, oauth.clientSecret",
  );
  await expect(editor.locator("#mcp-token-hint")).toHaveCount(0);
  await expect(editor.locator("#mcp-options-hint")).toHaveCount(0);
  await expect(
    editor.getByText(/Keep <saved> to reuse credentials/),
  ).toHaveCount(0);
  await editor.locator("#mcp-token").fill("Bearer synthetic-new");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor.locator("#mcp-options")).toBeFocused();
  expect((await saved(page)).jira.url).toBe("https://example.invalid/old");
  await editor.locator("#mcp-options").fill(
    JSON.stringify({
      headers: { "X-Workspace": "synthetic-new-workspace" },
      oauth: { clientId: "client", clientSecret: "synthetic-new-secret" },
    }),
  );
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expectSavedEditor(editor);
  await editor.getByRole("button", { name: "Close", exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect((await saved(page)).jira.url).toBe("https://example.invalid/new");
});

test("MCP identifies saved environment values when local arguments change", async ({
  page,
}) => {
  await mockMcp(page, {
    connections: {
      local: {
        command: "node",
        args: ["old.mjs"],
        env: { TOKEN: "synthetic-env" },
      },
    },
  });
  await openMcp(page);
  const editor = await manage(page, "local");
  await editor.locator("#mcp-args").fill("new.mjs");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor.locator("#mcp-options-error")).toContainText("env.TOKEN");
  await expect(editor.locator("#mcp-options")).toBeFocused();
  await editor
    .locator("#mcp-options")
    .fill(JSON.stringify({ env: { TOKEN: "synthetic-new-env" } }));
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expectSavedEditor(editor);
  await editor.getByRole("button", { name: "Close", exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect((await saved(page)).local.args).toEqual(["new.mjs"]);
});

test("MCP sign-in and sign-out update connections sharing an OAuth server without bootstrap", async ({
  page,
}) => {
  await mockMcp(page, {
    connections: {
      jira: { url: "https://example.invalid/mcp" },
      confluence: { url: "https://example.invalid:443/mcp" },
    },
  });
  const section = await openMcp(page);
  await page.evaluate(() => {
    (window as any).failBootstrap = true;
  });
  await section
    .getByRole("button", { name: "Sign in: jira", exact: true })
    .click();
  await expect(
    section.getByRole("button", { name: "Sign in: jira", exact: true }),
  ).toHaveCount(0);
  await expect(
    section.getByRole("button", { name: "Sign in: confluence", exact: true }),
  ).toHaveCount(0);
  const editor = await manage(page, "confluence");
  await editor.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    editor.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeVisible();
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    section.getByRole("button", { name: "Sign in: jira", exact: true }),
  ).toBeVisible();
  await expect(
    section.getByRole("button", { name: "Sign in: confluence", exact: true }),
  ).toBeVisible();
});

test("MCP can remove saved Authorization from its dedicated field", async ({
  page,
}) => {
  await mockMcp(page, {
    connections: {
      jira: {
        url: "https://example.invalid/mcp",
        headers: {
          Authorization: "Bearer synthetic",
          "X-Workspace": "synthetic",
        },
      },
    },
  });
  await openMcp(page);
  const editor = await manage(page, "jira");
  await expect(editor.locator("#mcp-token")).toHaveValue("<saved>");
  await editor.locator("#mcp-token").fill("");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expectSavedEditor(editor);
  await editor.getByRole("button", { name: "Close", exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect((await saved(page)).jira.headers).toEqual({
    "X-Workspace": "<saved>",
  });
  await expect(
    page.getByRole("button", { name: "Sign in: jira", exact: true }),
  ).toBeVisible();
});

test("MCP switches provider authentication to Authorization in one save", async ({
  page,
}) => {
  await mockMcp(page, {
    connections: {
      jira: {
        url: "https://example.invalid/mcp",
        auth: { provider: "github-copilot" },
        headers: { "X-Workspace": "synthetic-workspace" },
      },
    },
  });
  await openMcp(page);
  const editor = await manage(page, "jira");
  await expect(editor.locator("#mcp-token")).toHaveCount(0);
  await editor.locator("summary").click();
  const options = editor.locator("#mcp-options");
  const original = await options.inputValue();
  await options.fill("{");
  await expect(editor.locator("#mcp-token")).toHaveCount(0);
  await options.fill(JSON.stringify({ headers: { "X-Workspace": "<saved>" } }));
  const token = editor.locator("#mcp-token");
  await expect(token).toBeVisible();
  await token.fill("Bearer synthetic-replacement");
  // Editing the authentication options must not hide or erase a typed token.
  await options.fill(original);
  await expect(token).toBeVisible();
  await expect(token).toHaveValue("Bearer synthetic-replacement");
  await options.fill(JSON.stringify({ headers: { "X-Workspace": "<saved>" } }));
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expectSavedEditor(editor);
  await editor.getByRole("button", { name: "Close", exact: true }).click();
  await expect(editor).not.toBeVisible();
  const submissions = await page.evaluate(() =>
    (window as any).calls
      .filter((call: any) => call.name === "mcpSave")
      .map((call: any) => JSON.parse(call.input.config)),
  );
  expect(submissions).toHaveLength(1);
  expect(submissions[0].mcpServers.jira).toEqual({
    url: "https://example.invalid/mcp",
    enabled: true,
    headers: {
      "X-Workspace": "<saved>",
      Authorization: "Bearer synthetic-replacement",
    },
  });
});

for (const language of ["en", "zh"]) {
  test(`MCP errors use shared localized settings feedback: ${language}`, async ({
    page,
  }) => {
    await mockMcp(page, {
      language,
      connections: { jira: { url: "https://example.invalid/mcp" } },
    });
    await page.addInitScript(() => {
      const invoke = window.worklens.invoke;
      window.worklens.invoke = (async (name, input) => {
        if (name === "mcpTest")
          throw Error(
            "Error invoking remote method 'worklens': Error: Error: Sign in to this MCP server first\n    at internal.js:1",
          );
        if (name === "mcpSave")
          throw Error(
            "Error invoking remote method 'worklens': Error: Invalid MCP configuration. Check server names, transports and fields.",
          );
        return invoke(name, input);
      }) as typeof window.worklens.invoke;
    });
    const section = await openMcp(page, language);
    await testSavedConnection(page, "jira", language);
    await expect(
      page.locator('[data-slot="toast"]').filter({
        hasText:
          language === "en" ? "Couldn’t connect to jira" : "无法连接 jira",
      }),
    ).toContainText(
      language === "en"
        ? "Sign in to this MCP connection, then try again."
        : "请先登录此 MCP 连接，再重试。",
    );
    await expect(
      page.locator('[data-slot="toast"]').filter({
        hasText:
          language === "en" ? "Couldn’t connect to jira" : "无法连接 jira",
      }),
    ).not.toContainText(/Error:|remote method|internal\.js/);
    await section
      .getByRole("button", {
        name: language === "en" ? "Manage connection: jira" : "管理连接：jira",
        exact: true,
      })
      .click();
    const editor = page.getByRole("dialog", {
      name: language === "en" ? "Manage connection: jira" : "管理连接：jira",
      exact: true,
    });
    await editor.locator("#mcp-url").fill("https://example.invalid/new");
    await editor
      .getByRole("button", {
        name: language === "en" ? "Save" : "保存",
        exact: true,
      })
      .click();
    await expect(
      page.locator('[data-slot="toast"]').filter({
        hasText:
          language === "en"
            ? "Couldn’t update MCP settings"
            : "无法更新 MCP 设置",
      }),
    ).toContainText(
      language === "en"
        ? "Check the MCP connection names, connection types and configuration fields."
        : "请检查 MCP 连接名称、连接类型和配置字段。",
    );
    await expect(
      page.locator('[data-slot="toast"]').filter({
        hasText:
          language === "en"
            ? "Couldn’t update MCP settings"
            : "无法更新 MCP 设置",
      }),
    ).not.toContainText(/Error:|remote method/);
    await expect(editor.locator("#mcp-url")).toHaveValue(
      "https://example.invalid/new",
    );
  });
}

for (const theme of ["light", "dark"])
  for (const language of ["en", "zh"]) {
    test(`MCP remote presets: ${theme}, ${language}`, async ({
      page,
    }, info) => {
      await mockMcp(page, {
        theme,
        language,
        connections: {
          notion: { url: "https://existing.invalid/mcp" },
          notion_2: { url: "https://second.invalid/mcp" },
        },
      });
      const section = await openMcp(page, language);
      const add = language === "en" ? "Add connection" : "添加连接";
      await section.getByRole("button", { name: add, exact: true }).click();
      const editor = page.getByRole("dialog", { name: add, exact: true });
      const service = editor.getByRole("combobox", {
        name: language === "en" ? "Service" : "服务",
        exact: true,
      });
      await expect(service).toHaveValue("other");
      await expect(service.locator("option")).toHaveCount(6);
      await expect(service.locator('option[value="figma"]')).toHaveCount(0);
      await expect(service.locator('option[value="atlassian"]')).toContainText(
        "Jira / Confluence",
      );
      await editor.locator("#mcp-name").fill("custom");
      await editor.locator("#mcp-url").fill("https://custom.invalid/mcp");
      await editor.locator("#mcp-token").fill("Bearer custom-fixture");
      await editor.locator("summary").click();
      await editor
        .locator("#mcp-options")
        .fill('{"headers":{"X-Fixture":"custom-only"}}');
      const presets = {
        atlassian: "https://mcp.atlassian.com/v2/mcp",
        notion: "https://mcp.notion.com/mcp",
        linear: "https://mcp.linear.app/mcp",
        github: "https://api.githubcopilot.com/mcp/",
        sentry: "https://mcp.sentry.dev/mcp",
      };
      for (const [id, url] of Object.entries(presets)) {
        await service.selectOption(id);
        await expect(editor.locator("#mcp-name")).toHaveValue(
          id === "notion" ? "notion-3" : id,
        );
        await expect(editor.locator("#mcp-url")).toHaveValue(url);
        await expect(editor.locator("#mcp-url")).not.toBeEditable();
        await expect(editor.locator("#mcp-token")).toHaveValue("");
        await expect(editor.locator("#mcp-options")).toHaveValue("{}");
        await expect(editor.locator("[aria-invalid=true]")).toHaveCount(0);
      }
      await service.selectOption("notion");
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        expect(
          await editor.evaluate((el) => el.scrollWidth <= el.clientWidth),
        ).toBe(true);
        await page.screenshot({
          path: info.outputPath(`presets-${width}.png`),
        });
      }
      await service.selectOption("github");
      await expect(editor.locator("#mcp-token-hint")).toContainText("GitHub");
      await expect(
        editor.getByRole("button", { name: add, exact: true }),
      ).toBeDisabled();
      await editor.locator("#mcp-token").fill("invalid-fixture");
      await editor.getByRole("button", { name: add, exact: true }).click();
      await expect(editor.locator("#mcp-token-error")).toContainText("GitHub");

      await editor.locator("#mcp-token").fill("Bearer github-fixture");
      await service.selectOption("other");
      await expect(editor.locator("#mcp-name")).toHaveValue("custom");
      await expect(editor.locator("#mcp-url")).toBeEditable();
      await expect(editor.locator("#mcp-url")).toHaveValue(
        "https://custom.invalid/mcp",
      );
      await expect(editor.locator("#mcp-token")).toHaveValue(
        "Bearer custom-fixture",
      );
      await expect(editor.locator("#mcp-options")).toHaveValue(
        '{"headers":{"X-Fixture":"custom-only"}}',
      );
      await service.selectOption("github");
      await expect(editor.locator("#mcp-token")).toHaveValue(
        "Bearer github-fixture",
      );
      await editor.getByRole("button", { name: add, exact: true }).click();
      await expect(editor).not.toBeVisible();
      expect((await saved(page)).github).toEqual({
        url: presets.github,
        enabled: true,
        headers: { Authorization: "<saved>" },
      });
      const managed = await manageLocalized();
      await expect(managed.locator("#mcp-service")).toHaveCount(0);
      async function manageLocalized() {
        const label =
          language === "en" ? "Manage connection: github" : "管理连接：github";
        await page.getByRole("button", { name: label, exact: true }).click();
        return page.getByRole("dialog", { name: label, exact: true });
      }
    });
  }

test("MCP preset switching keeps manual and local setup independent", async ({
  page,
}) => {
  await mockMcp(page);
  const section = await openMcp(page);
  await section
    .getByRole("button", { name: "Add connection", exact: true })
    .click();
  const editor = page.getByRole("dialog", {
    name: "Add connection",
    exact: true,
  });
  await expect(editor.locator("#mcp-name")).toBeFocused();
  await editor.locator("#mcp-service").selectOption("notion");
  await editor.locator("#mcp-token").fill("Bearer notion-fixture");
  await editor.locator("#mcp-transport").selectOption("stdio");
  await expect(editor.locator("#mcp-service")).toHaveCount(0);
  await expect(editor.locator("#mcp-name")).toHaveValue("");
  await expect(editor.locator("#mcp-options")).toHaveValue("{}");
  await editor.locator("#mcp-transport").selectOption("http");
  await expect(editor.locator("#mcp-service")).toHaveValue("other");
  await expect(editor.locator("#mcp-token")).toHaveValue("");
  await editor.locator("#mcp-service").selectOption("notion");
  await expect(editor.locator("#mcp-token")).toHaveValue(
    "Bearer notion-fixture",
  );
  await editor.locator("#mcp-service").selectOption("other");
  await editor.locator("#mcp-name").fill("custom");
  await editor.locator("#mcp-url").fill("https://custom.invalid/mcp");
  await editor
    .getByRole("button", { name: "Add connection", exact: true })
    .click();
  await expect(editor).not.toBeVisible();
  expect((await saved(page)).custom).toEqual({
    url: "https://custom.invalid/mcp",
    enabled: true,
  });
});

for (const theme of ["light", "dark"])
  for (const language of ["en", "zh"]) {
    test(`MCP OAuth failure uses toast and shared test icons: ${theme}, ${language}`, async ({
      page,
    }, info) => {
      await mockMcp(page, {
        theme,
        language,
        connections: { figma: { url: "https://mcp.figma.com/mcp" } },
      });
      await page.addInitScript(() => {
        const invoke = window.worklens.invoke;
        window.worklens.invoke = (async (name, input) => {
          if (name === "mcpLogin")
            throw Error(
              "OAuthRegistrationError: OAuth dynamic client registration failed with status 403: Forbidden",
            );
          if (name === "mcpTest") {
            await new Promise((resolve) => setTimeout(resolve, 500));
            throw Error(
              "UnknownError: " + "unbounded upstream detail ".repeat(100),
            );
          }
          return invoke(name, input);
        }) as typeof window.worklens.invoke;
      });
      const section = await openMcp(page, language);
      const row = section.locator('[data-mcp-connection="figma"]');
      await expect(
        row.getByRole("button", { name: /Test connection|测试连接/ }),
      ).toHaveCount(0);
      const before = await row.boundingBox();
      await row
        .getByRole("button", {
          name: language === "en" ? "Sign in: figma" : "登录：figma",
          exact: true,
        })
        .click();
      const notification = page.locator('[data-slot="toast"]').filter({
        hasText:
          language === "en" ? "Couldn’t sign in to figma" : "无法登录 figma",
      });
      await expect(
        notification.locator('[data-slot="toast-description"]'),
      ).toHaveText(
        language === "en"
          ? "The service rejected this app’s registration. Check its supported apps."
          : "服务拒绝了此应用的注册，请查看它支持的应用。",
      );
      await expect(section.getByRole("alert")).toHaveCount(0);
      await expect(
        page.getByText(/OAuthRegistrationError|403: Forbidden/),
      ).toHaveCount(0);
      expect((await row.boundingBox())?.height).toBe(before?.height);
      await page.screenshot({ path: info.outputPath("oauth-toast.png") });
      await notification.locator('[data-slot="toast-close"]').click();
      const editor = await manage(page, "figma", language);
      const testToast = page.locator('[data-slot="toast"]').filter({
        hasText:
          language === "en" ? "Couldn’t connect to figma" : "无法连接 figma",
      });
      const editorTest = editor.getByRole("button", {
        name: language === "en" ? "Test connection" : "测试连接",
        exact: true,
      });
      await expect(editorTest.locator("svg.lucide-zap")).toBeVisible();
      await editorTest.click();
      await expect(
        editor
          .getByRole("button", {
            name: language === "en" ? "Testing…" : "测试中…",
            exact: true,
          })
          .locator("svg.lucide-loader-circle"),
      ).toBeVisible();
      await expect(
        testToast.locator('[data-slot="toast-description"]'),
      ).toHaveText(
        language === "en"
          ? "Check the service’s setup guide and try again."
          : "请检查服务的接入指南后重试。",
      );
      await expect(editorTest.locator("svg.lucide-zap")).toBeVisible();
      await expect(editor.getByRole("alert")).toHaveCount(0);
      await expect(editor).toBeVisible();
    });
  }

for (const theme of ["light", "dark"])
  for (const language of ["en", "zh"]) {
    test(`MCP pending sign-in stays in a dialog and can be cancelled: ${theme}, ${language}`, async ({
      page,
    }, info) => {
      await mockMcp(page, {
        theme,
        language,
        connections: { notion: { url: "https://mcp.notion.com/mcp" } },
      });
      await page.addInitScript(() => {
        const invoke = window.worklens.invoke;
        let onAuth: Parameters<typeof window.worklens.onAuth>[0] | undefined;
        let rejectLogin: ((error: Error) => void) | undefined;
        window.worklens.onAuth = (listener) => {
          onAuth = listener;
          return () => {
            onAuth = undefined;
          };
        };
        window.worklens.invoke = (async (name, input: any) => {
          if (name === "mcpLogin") {
            setTimeout(
              () =>
                onAuth?.({
                  type: "auth_url",
                  loginId: input.loginId,
                  url: "https://example.invalid/authorize",
                }),
              50,
            );
            return new Promise((_, reject) => {
              rejectLogin = reject;
            });
          }
          if (name === "authCancel") {
            rejectLogin?.(Error("Sign-in cancelled"));
            return;
          }
          return invoke(name, input);
        }) as typeof window.worklens.invoke;
      });
      const section = await openMcp(page, language);
      const signIn = section.getByRole("button", {
        name: language === "en" ? "Sign in: notion" : "登录：notion",
        exact: true,
      });
      for (const dismissal of ["cancel", "escape", "close"]) {
        await signIn.click();
        const dialog = page.getByRole("dialog", {
          name: language === "en" ? "Sign in to notion" : "登录 notion",
          exact: true,
        });
        await expect(dialog).toBeVisible();
        await expect(
          dialog.getByText(
            language === "en" ? "Waiting for sign-in…" : "等待登录…",
            { exact: true },
          ),
        ).toBeVisible();
        await expect(
          section.getByText(/Waiting for sign-in|等待登录/),
        ).toHaveCount(0);
        const openBrowser = dialog.getByRole("button", {
          name: language === "en" ? "Open browser" : "打开浏览器",
          exact: true,
        });
        await expect(openBrowser).toBeVisible();
        await openBrowser.click();
        if (dismissal === "cancel") {
          await page.screenshot({
            path: info.outputPath("sign-in-dialog.png"),
          });
          await dialog
            .getByRole("button", {
              name: language === "en" ? "Cancel" : "取消",
              exact: true,
            })
            .click();
        } else if (dismissal === "escape") await page.keyboard.press("Escape");
        else await dialog.locator('[data-slot="dialog-close"]').click();
        await expect(dialog).not.toBeVisible();
        await expect(signIn).toBeEnabled();
        await expect(page.locator('[data-slot="toast"]')).toHaveCount(0);
      }
      const manageLabel =
        language === "en" ? "Manage connection: notion" : "管理连接：notion";
      await section
        .getByRole("button", { name: manageLabel, exact: true })
        .click();
      const editor = page.getByRole("dialog", {
        name: manageLabel,
        exact: true,
      });
      await editor
        .getByRole("button", {
          name: language === "en" ? "Sign in" : "登录",
          exact: true,
        })
        .click();
      const progress = page.getByRole("dialog", {
        name: language === "en" ? "Sign in to notion" : "登录 notion",
        exact: true,
      });
      await expect(progress).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(progress).not.toBeVisible();
      await expect(editor).toBeVisible();
      await expect(
        editor.getByRole("button", {
          name: language === "en" ? "Test connection" : "测试连接",
          exact: true,
        }),
      ).toBeEnabled();
      await expect(page.locator('[data-slot="toast"]')).toHaveCount(0);
    });
  }

for (const language of ["en", "zh"]) {
  test(`MCP successful actions use one toast and retain test history: ${language}`, async ({
    page,
  }) => {
    await mockMcp(page, { language });
    const section = await openMcp(page, language);
    const add = language === "en" ? "Add connection" : "添加连接";
    const save = language === "en" ? "Save" : "保存";
    async function notice(title: string) {
      const notification = page
        .locator('[data-slot="toast"]:not([data-ending-style])')
        .filter({ hasText: title });
      await expect(notification).toHaveCount(1);
      await expect(
        notification.locator('[data-slot="toast-title"]'),
      ).toHaveText(title);
      await notification.locator('[data-slot="toast-close"]').click();
      await expect(notification).toHaveCount(0);
    }
    async function manageConnection() {
      const name =
        language === "en" ? "Manage connection: notion" : "管理连接：notion";
      await section.getByRole("button", { name, exact: true }).click();
      return page.getByRole("dialog", { name, exact: true });
    }
    await section.getByRole("button", { name: add, exact: true }).click();
    let editor = page.getByRole("dialog", { name: add, exact: true });
    await editor.locator("#mcp-service").selectOption("notion");
    await editor.getByRole("button", { name: add, exact: true }).click();
    await expect(editor).not.toBeVisible();
    await notice(language === "en" ? "MCP settings saved" : "MCP 设置已保存");
    const row = section.locator('[data-mcp-connection="notion"]');
    await testSavedConnection(page, "notion", language);
    await notice(
      language === "en" ? "notion connection successful" : "notion 连接成功",
    );
    const history =
      language === "en"
        ? "Last test passed · 3 tools available"
        : "最近一次测试通过 · 可用工具 3 个";
    await expect(row.getByRole("status")).toHaveText(history);
    editor = await manageConnection();
    await editor
      .getByRole("button", {
        name: language === "en" ? "Test connection" : "测试连接",
        exact: true,
      })
      .click();
    await notice(
      language === "en" ? "notion connection successful" : "notion 连接成功",
    );
    await expect(editor.getByRole("status")).toHaveText(history);
    await editor
      .getByRole("button", {
        name: language === "en" ? "Sign in" : "登录",
        exact: true,
      })
      .click();
    await notice(language === "en" ? "MCP sign-in complete" : "MCP 登录完成");
    await editor
      .getByRole("button", {
        name: language === "en" ? "Sign out" : "退出登录",
        exact: true,
      })
      .click();
    await notice(language === "en" ? "MCP signed out" : "已退出 MCP 登录");
    await editor
      .getByRole("switch", {
        name: language === "en" ? "Enable connection" : "启用此连接",
        exact: true,
      })
      .uncheck();
    await editor.getByRole("button", { name: save, exact: true }).click();
    await notice(language === "en" ? "MCP settings saved" : "MCP 设置已保存");
    await expectSavedEditor(editor, language);
    await editor
      .getByRole("button", {
        name: language === "en" ? "Delete" : "删除",
        exact: true,
      })
      .click();
    const confirmation = page.getByRole("dialog", {
      name: language === "en" ? "Delete notion?" : "删除 notion？",
      exact: true,
    });
    await confirmation
      .getByRole("button", {
        name: language === "en" ? "Delete" : "删除",
        exact: true,
      })
      .click();
    await notice(
      language === "en" ? "MCP connection deleted" : "MCP 连接已删除",
    );
    await section.getByRole("button", { name: add, exact: true }).click();
    editor = page.getByRole("dialog", { name: add, exact: true });
    await editor
      .getByRole("tab", {
        name: language === "en" ? "Import JSON" : "导入 JSON",
        exact: true,
      })
      .click();
    await editor.locator("#mcp-import").fill(
      JSON.stringify({
        mcpServers: { imported: { url: "https://example.invalid/mcp" } },
      }),
    );
    await editor
      .getByRole("button", {
        name: language === "en" ? "Import connections" : "导入连接",
        exact: true,
      })
      .click();
    await notice(language === "en" ? "MCP settings saved" : "MCP 设置已保存");
    await expect(
      section.locator('[data-mcp-connection="imported"]'),
    ).toBeVisible();
  });
}

for (const theme of ["light", "dark"])
  for (const language of ["en", "zh"]) {
    test(`Connector tabs preserve state and isolate matching services: ${theme}, ${language}`, async ({
      page,
    }, info) => {
      await mockMcp(page, {
        theme,
        language,
        connections: { jira: { url: "https://mcp.example.invalid/jira" } },
      });
      await page.addInitScript(() => {
        const invoke = window.worklens.invoke;
        let seeded = false;
        window.worklens.invoke = (async (name, input) => {
          if (name === "bootstrap" && !seeded) {
            seeded = true;
            await invoke("jiraSave", {
              url: "https://jira.example.invalid",
              deployment: "data-center",
              tokenType: "classic",
              token: "fixture-token",
            });
          }
          return invoke(name, input);
        }) as typeof window.worklens.invoke;
      });
      const mcp = await openMcp(page, language);
      const content = page.locator('[data-section="connections"]');
      const mcpTab = content.getByRole("tab", { name: "MCP", exact: true });
      const builtinTab = content.getByRole("tab", {
        name: language === "en" ? "Built-in" : "内置连接",
        exact: true,
      });
      await expect(
        page
          .locator(".settings-navigation")
          .getByRole("button", { name: "MCP", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("heading", {
          name: language === "en" ? "Connectors" : "连接器",
          exact: true,
        }),
      ).toBeVisible();
      for (const tab of [builtinTab, mcpTab]) {
        await expect(tab.locator(".settings-group-count")).toHaveText("1");
        await expect(tab).toHaveAccessibleDescription(
          language === "en" ? "1 connection" : "1 个连接",
        );
      }
      await expect(
        mcp.getByRole("button", { name: /Test connection|测试连接/ }),
      ).toHaveCount(0);
      await testSavedConnection(page, "jira", language);
      await expect(mcp.getByRole("status")).toContainText("3");
      const mcpSearch = mcp.getByRole("textbox", {
        name: language === "en" ? "Search connections" : "搜索连接",
        exact: true,
      });
      await mcpSearch.fill(" EXAMPLE.INVALID ");
      await expect(mcp.getByRole("listitem")).toHaveCount(1);
      await mcpSearch.fill("missing");
      await expect(mcpTab.locator(".settings-group-count")).toHaveText("1");
      await expect(builtinTab.locator(".settings-group-count")).toHaveText("1");
      await expect(mcp.getByRole("listitem")).toHaveCount(0);
      await expect(mcp.locator(".settings-empty")).toBeVisible();
      await mcp
        .getByRole("button", {
          name: language === "en" ? "Clear search" : "清除搜索",
        })
        .click();
      await expect(mcpSearch).toBeFocused();
      await mcpSearch.fill("JIRA");
      await expect(mcp.getByRole("listitem")).toHaveCount(1);
      const beforeCalls = await page.evaluate(
        () => (window as any).calls.length,
      );
      await mcpTab.focus();
      await page.keyboard.press("ArrowLeft");
      await expect(builtinTab).toBeFocused();
      await expect(builtinTab).toHaveAttribute("aria-selected", "true");
      await expect(mcp).not.toBeVisible();
      const builtin = page.getByRole("tabpanel", {
        name: language === "en" ? "Built-in" : "内置连接",
        exact: true,
      });
      const search = builtin.getByRole("textbox", {
        name: language === "en" ? "Search connectors" : "搜索连接器",
      });
      await search.fill("Jira");
      await expect(builtin.getByRole("listitem")).toHaveCount(1);
      await expect(
        builtin.getByText("https://jira.example.invalid", { exact: true }),
      ).toBeVisible();
      await builtinTab.focus();
      await page.keyboard.press("ArrowRight");
      await expect(mcpTab).toBeFocused();
      await expect(mcpSearch).toHaveValue("JIRA");
      await expect(mcp.getByRole("status")).toContainText("3");
      expect(await page.evaluate(() => (window as any).calls.length)).toBe(
        beforeCalls,
      );
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        expect(
          await content.evaluate((el) => el.scrollWidth <= el.clientWidth),
        ).toBe(true);
        await page.screenshot({
          path: info.outputPath(`mcp-tab-${width}.png`),
        });
        await builtinTab.click();
        await expect(search).toHaveValue("Jira");
        await page.screenshot({
          path: info.outputPath(`builtin-tab-${width}.png`),
        });
        await mcpTab.click();
      }
      const manageMcp =
        language === "en" ? "Manage connection: jira" : "管理连接：jira";
      await mcp.getByRole("button", { name: manageMcp, exact: true }).click();
      const editor = page.getByRole("dialog", { name: manageMcp, exact: true });
      await editor
        .locator("#mcp-url")
        .fill("https://mcp.example.invalid/draft");
      await expect(
        page.getByRole("tab", {
          name: language === "en" ? "Built-in" : "内置连接",
          exact: true,
        }),
      ).toHaveCount(0);
      await page.keyboard.press("Escape");
      expect((await saved(page)).jira.url).toBe(
        "https://mcp.example.invalid/jira",
      );
      await builtinTab.click();
      await builtin
        .getByRole("button", {
          name: language === "en" ? "Manage Jira" : "管理 Jira",
          exact: true,
        })
        .click();
      const builtinEditor = page.getByRole("dialog", {
        name: "Jira",
        exact: true,
      });
      await expect(
        page.getByRole("tab", { name: "MCP", exact: true }),
      ).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(builtinEditor).not.toBeVisible();
      await mcpTab.click();
      await mcp.getByRole("button", { name: manageMcp, exact: true }).click();
      await editor
        .getByRole("button", {
          name: language === "en" ? "Delete" : "删除",
          exact: true,
        })
        .click();
      const confirm = page.getByRole("dialog", {
        name: language === "en" ? "Delete jira?" : "删除 jira？",
        exact: true,
      });
      await confirm
        .getByRole("button", {
          name: language === "en" ? "Delete" : "删除",
          exact: true,
        })
        .click();
      await expect(confirm).not.toBeVisible();
      await expect(editor).not.toBeVisible();
      expect(await saved(page)).toEqual({});
      await expect(mcpTab.locator(".settings-group-count")).toHaveText("0");
      await builtinTab.click();
      await expect(search).toHaveValue("Jira");
      await expect(
        builtin.getByRole("button", {
          name: language === "en" ? "Manage Jira" : "管理 Jira",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        builtin.getByText("https://jira.example.invalid", { exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(() =>
          (window as any).calls.filter(
            (call: any) => call.name === "jiraRemove",
          ),
        ),
      ).toEqual([]);
      await mcpTab.click();
      const add = language === "en" ? "Add connection" : "添加连接";
      await mcp.getByRole("button", { name: add, exact: true }).click();
      const added = page.getByRole("dialog", { name: add, exact: true });
      await added.locator("#mcp-name").fill("jira");
      await added.locator("#mcp-url").fill("https://mcp.example.invalid/jira");
      await added.getByRole("button", { name: add, exact: true }).click();
      await expect(added).not.toBeVisible();
      await expect(mcpTab.locator(".settings-group-count")).toHaveText("1");
      await builtinTab.click();
      await builtin
        .getByRole("button", {
          name: language === "en" ? "Manage Jira" : "管理 Jira",
          exact: true,
        })
        .click();
      const disconnect = language === "en" ? "Disconnect" : "断开连接";
      await builtinEditor
        .getByRole("button", { name: disconnect, exact: true })
        .click();
      const disconnectDialog = page.getByRole("dialog", {
        name: language === "en" ? "Disconnect Jira?" : "断开 Jira 的连接？",
        exact: true,
      });
      await disconnectDialog
        .getByRole("button", { name: disconnect, exact: true })
        .click();
      await expect(disconnectDialog).not.toBeVisible();
      await expect(builtinTab.locator(".settings-group-count")).toHaveText("0");
      await expect(mcpTab.locator(".settings-group-count")).toHaveText("1");
      await expect(
        builtin.getByRole("button", {
          name: language === "en" ? "Connect Jira" : "连接 Jira",
          exact: true,
        }),
      ).toBeVisible();
      await mcpTab.click();
      await expect(
        mcp.getByRole("button", { name: manageMcp, exact: true }),
      ).toBeVisible();
      expect((await saved(page)).jira.url).toBe(
        "https://mcp.example.invalid/jira",
      );
    });
  }

for (const theme of ["light", "dark"])
  for (const language of ["en", "zh"]) {
    test(`Connector counts include saved failures and disabled MCP connections: ${theme}, ${language}`, async ({
      page,
    }, info) => {
      await mockMcp(page, {
        theme,
        language,
        connections: {
          enabled: { url: "https://example.invalid/one" },
          disabled: { command: "node", enabled: false },
        },
      });
      await page.addInitScript(() => {
        const invoke = window.worklens.invoke;
        window.worklens.invoke = (async (name, input) => {
          const value = await invoke(name, input);
          if (name === "bootstrap") {
            const data = value as Requests["bootstrap"]["output"];
            data.github = {
              url: "https://github.com",
              configured: false,
              error: "Fixture validation failure",
            };
            data.tavily = { url: "https://api.tavily.com", configured: true };
          }
          return value;
        }) as typeof window.worklens.invoke;
      });
      const section = await openMcp(page, language);
      const tabs = page.locator(".settings-connector-tabs");
      await expect(tabs.locator(".settings-group-count")).toHaveText([
        "2",
        "2",
      ]);
      await expect(
        tabs.getByRole("tab", { name: "MCP", exact: true }),
      ).toHaveAccessibleDescription(
        language === "en" ? "2 connections" : "2 个连接",
      );
      await page.setViewportSize({ width: 1100, height: 850 });
      await page.screenshot({
        path: info.outputPath("mcp.png"),
      });
      await section.getByRole("textbox").fill("missing");
      await expect(section.getByRole("listitem")).toHaveCount(0);
      await expect(tabs.locator(".settings-group-count")).toHaveText([
        "2",
        "2",
      ]);
      await tabs
        .getByRole("tab", {
          name: language === "en" ? "Built-in" : "内置连接",
          exact: true,
        })
        .click();
      const builtin = page.getByRole("tabpanel", {
        name: language === "en" ? "Built-in" : "内置连接",
        exact: true,
      });
      const added = builtin.locator("section").filter({
        has: page.getByRole("heading", {
          name: language === "en" ? "Connected" : "已连接",
          exact: true,
        }),
      });
      const github = added.locator('[data-connection="github"]');
      await expect(
        github.getByText(language === "en" ? "Needs attention" : "需要处理", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        github.getByText("https://github.com", { exact: true }),
      ).toBeVisible();
      await expect(
        github.getByRole("button", {
          name: language === "en" ? "Manage GitHub" : "管理 GitHub",
          exact: true,
        }),
      ).toBeVisible();
      await expect(added.getByRole("listitem")).toHaveCount(2);
      await expect(
        builtin
          .locator("section")
          .filter({
            has: page.getByRole("heading", {
              name: language === "en" ? "Available" : "可连接",
              exact: true,
            }),
          })
          .getByRole("listitem"),
      ).toHaveCount(3);
      await page.screenshot({
        path: info.outputPath("builtin.png"),
      });
      await builtin.getByRole("combobox").selectOption("connected");
      await expect(github).toBeVisible();
      await expect(builtin.getByRole("listitem")).toHaveCount(2);
      await github.getByRole("button").click();
      const editor = page.getByRole("dialog", { name: "GitHub", exact: true });
      await expect(
        editor.getByRole("button", {
          name: language === "en" ? "Disconnect" : "断开连接",
          exact: true,
        }),
      ).toBeVisible();
      await expect(editor.locator("#github-url")).toHaveValue(
        "https://github.com",
      );
      await editor
        .getByRole("button", {
          name: language === "en" ? "Close" : "关闭",
          exact: true,
        })
        .click();
      await builtin.getByRole("textbox").fill("missing");
      await builtin.getByRole("combobox").selectOption("connected");
      await expect(builtin.getByRole("listitem")).toHaveCount(0);
      await expect(tabs.locator(".settings-group-count")).toHaveText([
        "2",
        "2",
      ]);
    });
  }

test("MCP edits stay open for testing and reset masked credentials only after saving", async ({
  page,
}) => {
  await mockMcp(page, {
    connections: {
      jira: {
        url: "https://example.invalid/mcp",
        enabled: true,
        headers: { Authorization: "Bearer synthetic-old" },
      },
    },
  });
  const section = await openMcp(page);
  await expect(
    section.getByRole("button", { name: /Test connection/ }),
  ).toHaveCount(0);
  const editor = await manage(page, "jira");
  const token = editor.locator("#mcp-token");
  const saveButton = editor.getByRole("button", { name: "Save", exact: true });
  const testButton = editor.getByRole("button", {
    name: "Test connection",
    exact: true,
  });
  await token.fill("Bearer synthetic-new");
  await expect(testButton).toBeDisabled();
  await page.evaluate(() => {
    (window as any).failMcpSave = true;
  });
  await saveButton.click();
  await expect(
    page
      .locator('[data-slot="toast"]')
      .filter({ hasText: "Couldn’t update MCP settings" }),
  ).toBeVisible();
  await expect(token).toHaveValue("Bearer synthetic-new");
  await expect(testButton).toBeDisabled();
  await page.evaluate(() => {
    (window as any).failMcpSave = false;
  });
  await saveButton.click();
  await expectSavedEditor(editor);
  await expect(token).toHaveValue("<saved>");
  await testButton.click();
  await expect(editor.getByRole("status")).toHaveText(
    "Last test passed · 3 tools available",
  );
  await token.fill("Bearer synthetic-newer");
  await expect(editor.getByRole("status")).toHaveCount(0);
  await saveButton.click();
  await expectSavedEditor(editor);
  await expect(token).toHaveValue("<saved>");
  await expect(editor.getByRole("status")).toHaveCount(0);
  await testButton.click();
  await expect(editor.getByRole("status")).toContainText("3 tools available");
});
