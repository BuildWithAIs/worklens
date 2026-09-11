import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
} from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mockServer, fixtureModel } from "../mock-server";

test("Usage: real Pi → IPC → header, concurrent runs, cancellation, restart and deletion", async ({}, info) => {
  const root = await mkdtemp(join(tmpdir(), "worklens-usage-e2e-"));
  const server = await mockServer();
  const env: NodeJS.ProcessEnv = { ...process.env, WORKLENS_TEST_ROOT: root };
  delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | undefined;
  const errors: string[] = [];
  const launch = async () => {
    app = await electron.launch({
      args: ["."],
      cwd: resolve("."),
      env: env as Record<string, string>,
    });
    const page = await app.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    await expect(page.locator(".sidebar")).toBeVisible();
    return page;
  };
  try {
    const page = await launch();
    await app!.evaluate(
      async (_electron, { uri, url, model }) => {
        const vm = process.getBuiltinModule("node:vm");
        const { agents } = await vm.runInThisContext(
          `import(${JSON.stringify(uri)})`,
          {
            importModuleDynamically:
              vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
          },
        );
        agents.modelRuntime.registerProvider("worklens-test", {
          name: "Local test",
          api: "openai-completions",
          baseUrl: url,
          apiKey: "fixture",
          models: [model],
        });
        await agents.modelRuntime.refresh({ allowNetwork: false });
      },
      {
        uri: pathToFileURL(resolve("dist/main/index.js")).href,
        url: server.url,
        model: {
          ...fixtureModel,
          cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
        },
      },
    );
    await page.evaluate(() =>
      window.worklens.invoke("settings", {
        riskAccepted: true,
        defaults: {
          provider: "worklens-test",
          model: "worklens-test",
          thinking: "off",
        },
      }),
    );
    await page.reload();
    await expect(page.locator(".usage-total strong")).toHaveText("0");
    const target = join(root, "usage-output.txt");
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill(
        "TOOL " +
          JSON.stringify({
            name: "write",
            args: { path: target, content: "usage verified" },
          }),
      );
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect(page.locator(".usage-trigger")).toContainText("280 tokens", {
      timeout: 30000,
    });
    await expect(page.locator(".usage-live-dot")).toHaveCount(0);
    expect(await readFile(target, "utf8")).toBe("usage verified");
    await page.locator(".usage-trigger").click();
    await expect(page.getByTestId("run-usage")).toContainText("Completed");
    await expect(page.getByTestId("conversation-usage")).toContainText("280");
    await page.screenshot({
      path: info.outputPath("usage-real-electron.png"),
      fullPage: true,
    });
    await page.keyboard.press("Escape");
    const first = await page.evaluate(
      async () =>
        (await window.worklens.invoke("bootstrap", undefined)).conversations[0],
    );
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("Second run");
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect(page.locator(".usage-total strong")).toHaveText("420");
    await expect(page.locator(".usage-trigger")).toContainText("140 tokens");
    await expect(page.locator(".usage-live-dot")).toHaveCount(0);
    await page.getByRole("button", { name: "New chat", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("SLOW background " + "waiting ".repeat(60));
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect(page.locator(".usage-live-dot")).toBeVisible();
    const slow = await page.evaluate(
      async () =>
        (
          await window.worklens.invoke("bootstrap", undefined)
        ).conversations.find((c) => c.title.startsWith("SLOW"))!,
    );
    await page.getByRole("button", { name: "New chat", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("Independent foreground");
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect(page.locator(".usage-total strong")).toHaveText("560");
    await page
      .locator(".conversation-open")
      .filter({ hasText: "SLOW background" })
      .click();
    await page.getByRole("button", { name: "Stop task", exact: true }).click();
    await expect(page.locator(".usage-live-dot")).toHaveCount(0);
    await page.locator(".usage-trigger").click();
    await expect(page.getByTestId("run-usage")).toContainText("Cancelled");
    await page.keyboard.press("Escape");
    const beforeRestart = await page.evaluate(() =>
      window.worklens.invoke("bootstrap", undefined),
    );
    expect(beforeRestart.globalUsage).toMatchObject({
      totalTokens: 560,
      status: "partial",
    });
    await page.evaluate(
      (id) =>
        window.worklens.invoke("settings", {
          lastConversation: id,
          theme: "dark",
        }),
      first.id,
    );
    await app!.close();
    app = undefined;
    const restored = await launch();
    // No provider re-registration: inspecting retained usage requires no credentials.
    await restored
      .getByRole("button", { name: "Close settings", exact: true })
      .click();
    await restored
      .locator(".conversation-open")
      .filter({ hasText: first.title })
      .click();
    await expect(restored.locator(".usage-total strong")).toHaveText("560+");
    await expect(restored.locator(".usage-trigger")).toContainText(
      "140 tokens",
    );
    await restored.locator(".usage-trigger").click();
    await expect(restored.getByTestId("conversation-usage")).toContainText(
      "420",
    );
    await expect(restored.getByTestId("run-usage")).toContainText("Completed");
    await restored.screenshot({
      path: info.outputPath("usage-restored-dark.png"),
      fullPage: true,
    });
    await restored.keyboard.press("Escape");
    await restored
      .getByRole("button", {
        name: `Conversation options: ${slow.title}`,
        exact: true,
      })
      .click();
    await restored
      .getByRole("menuitem", { name: "Delete", exact: true })
      .click();
    await restored
      .getByRole("dialog", { name: "Delete conversation?" })
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await expect(restored.locator(".usage-total strong")).toHaveText("560");
    await restored
      .getByRole("button", {
        name: "Conversation options: Independent foreground",
        exact: true,
      })
      .click();
    await restored
      .getByRole("menuitem", { name: "Delete", exact: true })
      .click();
    await restored
      .getByRole("dialog", { name: "Delete conversation?" })
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await expect(restored.locator(".usage-total strong")).toHaveText("420");
    expect(errors).toEqual([]);
  } finally {
    await app?.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
