import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
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
  const total = async (page: Page, expected: string) => {
    await page.locator(".usage-trigger").click();
    await page.getByRole("tab", { name: "Details", exact: true }).click();
    await expect(page.locator(".usage-total strong")).toHaveText(expected);
    await page.keyboard.press("Escape");
  };
  const completedRun = async (page: Page, tokens: string) => {
    await expect(page.getByRole("button", { name: "Stop task", exact: true })).toHaveCount(0, { timeout: 30000 });
    await page.locator(".usage-trigger").click();
    await expect(page.locator(".usage-run-state")).toContainText("Completed");
    await expect(page.getByTestId("run-usage")).toContainText(tokens);
    await page.keyboard.press("Escape");
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
    await total(page, "0");
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
    await completedRun(page, "280");
    expect(await readFile(target, "utf8")).toBe("usage verified");
    await page.locator(".usage-trigger").click();
    await expect(page.locator(".usage-run-state")).toContainText("Completed");
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
    await expect(page.getByRole("region", { name: "Pinned", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: `Conversation options: ${first.title}`, exact: true }).click();
    await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
    await expect(page.getByRole("region", { name: "Pinned", exact: true }).locator(".conversation-open")).toHaveCount(1);
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("Second run");
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await total(page, "420");
    await completedRun(page, "140");
    await page.getByRole("button", { name: "New chat", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("SLOW background " + "waiting ".repeat(60));
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect(page.locator(".conversation-item.selected .history-loading-ring")).toBeVisible();
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
    await total(page, "560");
    await page
      .locator(".conversation-open")
      .filter({ hasText: "SLOW background" })
      .click();
    await page.getByRole("button", { name: "Stop task", exact: true }).click();
    await expect(page.getByRole("button", { name: "Stop task", exact: true })).toHaveCount(0);
    await page.locator(".usage-trigger").click();
    await expect(page.locator(".usage-run-state")).toContainText("Cancelled");
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
    await expect(
      restored.getByRole("dialog", { name: "Settings", exact: true }),
    ).toHaveCount(0);
    await restored
      .locator(".conversation-open")
      .filter({ hasText: first.title })
      .click();
    const pinned = restored.getByRole("region", { name: "Pinned", exact: true });
    await expect(pinned.locator(".conversation-open")).toHaveText(first.title);
    await pinned.getByRole("button", { name: `Conversation options: ${first.title}`, exact: true }).click();
    await expect(restored.getByRole("menuitem", { name: "Unpin", exact: true }).locator("svg")).toBeVisible();
    await restored.getByRole("menuitem", { name: "Unpin", exact: true }).click();
    await expect(pinned).toHaveCount(0);
    await total(restored, "560+");
    await completedRun(restored, "140");
    await restored.locator(".usage-trigger").click();
    await expect(restored.getByTestId("conversation-usage")).toContainText(
      "420",
    );
    await expect(restored.locator(".usage-run-state")).toContainText("Completed");
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
    await total(restored, "560");
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
    await total(restored, "420");
    expect(errors).toEqual([]);
  } finally {
    await app?.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
