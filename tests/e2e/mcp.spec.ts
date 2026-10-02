import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
} from "@playwright/test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { mockServer, fixtureModel } from "../mock-server";

for (const packaged of [false, true])
  test(`MCP and Code Mode ${packaged ? "packaged ASAR" : "Electron"}: settings, calls, nested files and restart`, async () => {
    test.skip(
      packaged && !process.env.WORKLENS_PACKAGED_EXE,
      "Run after Windows packaging",
    );
    const root = await mkdtemp(join(tmpdir(), "worklens-mcp-desktop-"));
    const server = await mockServer();
    let app: ElectronApplication | undefined;
    const env: NodeJS.ProcessEnv = { ...process.env, WORKLENS_TEST_ROOT: root };
    delete env.ELECTRON_RUN_AS_NODE;
    for (const key of Object.keys(env))
      if (
        /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|GITHUB_TOKEN|GH_TOKEN)$/.test(key)
      )
        delete env[key];
    const launch = async () => {
      app = await electron.launch({
        args: packaged ? [] : ["."],
        ...(packaged
          ? { executablePath: resolve(process.env.WORKLENS_PACKAGED_EXE!) }
          : {}),
        cwd: resolve("."),
        env: env as Record<string, string>,
      });
      const page = await app.firstWindow();
      await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.show();
        window.focus();
      });
      await page.bringToFront();
      await expect(page.locator(".sidebar")).toBeVisible();
      return page;
    };
    try {
      let page = await launch();
      if (
        !(await page
          .getByRole("dialog", { name: "Settings", exact: true })
          .isVisible())
      )
        await page
          .getByRole("button", { name: "Settings", exact: true })
          .click();
      await page
        .getByRole("button", { name: "Connectors", exact: true })
        .click();
      await expect(page.locator("[data-mcp-settings]")).toHaveCount(0);
      await page
        .locator(".settings-navigation")
        .getByRole("button", { name: "MCP", exact: true })
        .click();
      await expect(page.locator('[data-section="mcp"]')).toBeVisible();
      const section = page.locator("[data-mcp-settings]");
      await expect(section.getByText(/no programming is needed/)).toBeVisible();
      await expect(
        section.getByText(
          "Let the agent combine tool calls in JavaScript workflows.",
          { exact: true },
        ),
      ).toBeVisible();
      await section.locator("#mcp-config").fill(
        JSON.stringify(
          {
            mcpServers: {
              fixture: {
                command: process.execPath,
                args: [resolve("tests/fixtures/mcp-server.mjs")],
                env: {
                  TOKEN: "synthetic-mcp-secret",
                  ELECTRON_RUN_AS_NODE: "1",
                },
              },
            },
          },
          null,
          2,
        ),
      );
      await section.getByRole("button", { name: "Save", exact: true }).click();
      await expect(section.locator("#mcp-config")).toHaveValue(/<saved>/);
      await expect(section.locator("#mcp-config")).not.toHaveValue(
        /synthetic-mcp-secret/,
      );
      await section
        .getByRole("button", { name: "Test connection", exact: true })
        .click();
      await expect(
        page.getByText("Connected. 3 tools available."),
      ).toBeVisible();
      await expect(section.getByRole("alert")).toHaveCount(0);
      await page.screenshot({
        path: `test-results/mcp-${packaged ? "packaged" : "electron"}.png`,
        fullPage: true,
      });
      expect(
        await readFile(join(root, "app", "pi", "mcp-settings.json"), "utf8"),
      ).not.toContain("synthetic-mcp-secret");
      await app!.evaluate(
        async ({ app }, { url, model }) => {
          const vm = process.getBuiltinModule("node:vm");
          const uri = process
            .getBuiltinModule("node:url")
            .pathToFileURL(app.getAppPath() + "/dist/main/index.js").href;
          const imported = await vm.runInThisContext(
            `import(${JSON.stringify(uri)})`,
            {
              importModuleDynamically:
                vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
            },
          );
          imported.agents.modelRuntime.registerProvider("worklens-test", {
            api: "openai-completions",
            baseUrl: url,
            apiKey: "fixture",
            models: [model],
          });
          await imported.agents.modelRuntime.refresh({ allowNetwork: false });
        },
        { url: server.url, model: fixtureModel },
      );
      const selection = {
        provider: "worklens-test",
        model: "worklens-test",
        thinking: "off" as const,
      };
      await page.evaluate(
        (selection) =>
          window.worklens.invoke("settings", {
            riskAccepted: true,
            defaults: selection,
          }),
        selection,
      );
      const view = await page.evaluate(
        (selection) =>
          window.worklens.invoke("send", {
            selection,
            requestId: crypto.randomUUID(),
            text:
              "TOOL " +
              JSON.stringify({
                name: "codemode",
                args: {
                  code: 'await describeNamespace("mcp__fixture"); text(await tools.mcp__fixture__echo({text:"PACKAGED_MCP_OK"})); text(await tools.write({path:"codemode-output.txt",content:"PACKAGED_CODEMODE_OK"})); store("answer",42);',
                },
              }),
          }),
        selection,
      );
      await expect
        .poll(
          async () =>
            (
              await page.evaluate(
                (id) => window.worklens.invoke("open", { id }),
                view.id,
              )
            ).phase,
          { timeout: 30000 },
        )
        .toBe("completed");
      const opened = await page.evaluate(
        (id) => window.worklens.invoke("open", { id }),
        view.id,
      );
      expect(
        opened.messages.find((message) => message.toolName === "codemode")
          ?.status,
      ).toBe("success");
      expect(
        opened.messages.find(
          (message) => message.toolName === "mcp__fixture__echo",
        ),
      ).toMatchObject({
        status: "success",
        text: "PACKAGED_MCP_OK",
        parentToolCallId: expect.any(String),
      });
      expect(
        await readFile(
          join(root, "sessions", view.id, "workspace", "codemode-output.txt"),
          "utf8",
        ),
      ).toBe("PACKAGED_CODEMODE_OK");
      await app!.close();
      page = await launch();
      const saved = await page.evaluate(() =>
        window.worklens.invoke("bootstrap", undefined),
      );
      expect(saved.mcp?.servers).toEqual([
        expect.objectContaining({ name: "fixture", enabled: true }),
      ]);
      const restored = await page.evaluate(
        (id) => window.worklens.invoke("open", { id }),
        view.id,
      );
      expect(
        restored.messages.filter((message) => message.parentToolCallId),
      ).toEqual(opened.messages.filter((message) => message.parentToolCallId));
      await page.evaluate(() =>
        window.worklens.invoke("settings", { codemodeEnabled: false }),
      );
      expect(
        (
          await page.evaluate(() =>
            window.worklens.invoke("bootstrap", undefined),
          )
        ).tools,
      ).not.toContain("codemode");
    } finally {
      await app?.close();
      await server.close();
    }
  });
