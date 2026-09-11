import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
} from "@playwright/test";
import { mkdtemp, readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mockServer, fixtureModel } from "../mock-server";

test("PRD 001, 030-063: actual Electron setup, file task, themes and restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "worklens-desktop-"));
  const server = await mockServer();
  const vault = join(directory, "app", "credentials");
  await mkdir(vault, { recursive: true });
  await writeFile(
    join(vault, createHash("sha256").update("openai").digest("hex") + ".json"),
    "{corrupt-test-vault",
  );
  let app: ElectronApplication | undefined;
  const errors: string[] = [];
  const launch = async () => {
    const launchedAt = performance.now();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      WORKLENS_TEST_ROOT: directory,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const instance = await electron.launch({
      args: ["."],
      cwd: resolve("."),
      env: env as Record<string, string>,
    });
    app = instance;
    const window = await instance.firstWindow();
    window.on("pageerror", (error) => errors.push(error.message));
    await expect(window.locator(".sidebar")).toBeVisible();
    console.log(
      `Electron fresh process to interactive: ${(performance.now() - launchedAt).toFixed(0)} ms`,
    );
    return { instance, window };
  };
  try {
    const first = await launch();
    app = first.instance;
    const page = first.window;
    await expect(
      page.getByRole("heading", { name: "Providers", exact: true }),
    ).toBeVisible();
    expect(await page.evaluate(() => typeof (window as any).require)).toBe(
      "undefined",
    );
    await page.screenshot({
      path: "test-results/onboarding-light.png",
      fullPage: true,
    });
    await page
      .getByRole("textbox", { name: "Search providers" })
      .fill("OpenAI");
    const openai = page.locator(".settings-entry").filter({
      has: page.locator(".settings-entry-title", {
        hasText: /^OpenAI(?!\s*Codex)/,
      }),
    });
    await expect(
      openai.getByText("Saved credentials need attention", { exact: true }),
    ).toBeVisible();
    await openai.getByRole("button", { name: "Manage", exact: true }).click();
    await page
      .locator("input[type=password]")
      .fill("worklens-placeholder-credential-for-test");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      openai.getByRole("button", { name: "Manage", exact: true }),
    ).toBeVisible();
    const secretDirectory = join(directory, "app", "credentials");
    const encryptedFiles = await readdir(secretDirectory);
    expect(encryptedFiles.length).toBeGreaterThan(0);
    for (const file of encryptedFiles)
      expect(await readFile(join(secretDirectory, file), "utf8")).not.toContain(
        "worklens-placeholder-credential-for-test",
      );
    expect(
      JSON.stringify(
        await page.evaluate(() =>
          window.worklens.invoke("bootstrap", undefined),
        ),
      ),
    ).not.toContain("worklens-placeholder-credential-for-test");
    // Inject a local HTTP fixture from the test's main-process debugger, never from renderer APIs.
    const mainUrl = pathToFileURL(resolve("dist/main/index.js")).href;
    await app.evaluate(
      async (_electron, { mainUrl, url, model }) => {
        const vm = process.getBuiltinModule("node:vm");
        const imported = await vm.runInThisContext(
          `import(${JSON.stringify(mainUrl)})`,
          {
            importModuleDynamically:
              vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
          },
        );
        imported.agents.modelRuntime.registerProvider("worklens-test", {
          name: "本地测试服务",
          api: "openai-completions",
          baseUrl: url,
          apiKey: "test-placeholder",
          models: [model],
        });
        await imported.agents.modelRuntime.refresh({ allowNetwork: false });
      },
      { mainUrl, url: server.url, model: fixtureModel },
    );
    await page
      .getByRole("button", { name: "Refresh providers", exact: true })
      .click();
    await page.getByRole("button", { name: "Models", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Search models", exact: true })
      .fill("本地测试模型");
    await page
      .getByRole("button", {
        name: "Test connection: 本地测试模型",
        exact: true,
      })
      .click();
    await expect(
      page.getByText("Connection successful", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Close settings", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Choose model", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Search models", exact: true })
      .fill("本地测试模型");
    await page
      .getByRole("button", { name: "本地测试模型", exact: true })
      .click();
    await page.keyboard.press("Escape");
    await page.screenshot({
      path: "test-results/chat-empty-light.png",
      fullPage: true,
    });
    const finished = async (state: "Completed" | "Cancelled" = "Completed") => {
      await expect(page.locator(".run-status")).toHaveCount(0, {
        timeout: 30000,
      });
      await page.locator(".usage-trigger").click();
      await expect(page.getByTestId("run-usage")).toContainText(state, {
        timeout: 30000,
      });
      await page.keyboard.press("Escape");
    };
    const target = join(directory, "actual-file.txt");
    await page.getByRole("textbox", { name: "Message", exact: true }).fill(
      "TOOL " +
        JSON.stringify({
          name: "write",
          args: { path: target, content: "WorkLens Electron 实测成功" },
        }),
    );
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await finished();
    expect(await readFile(target, "utf8")).toBe("WorkLens Electron 实测成功");
    await page.locator('[data-slot="reasoning-trigger"]').first().click();
    await page.locator('[data-slot="tool-fallback-trigger"]').first().click();
    await expect(
      page.locator('[data-slot="tool-fallback-root"]'),
    ).toContainText(target);
    await page.screenshot({
      path: "test-results/tool-task-light.png",
      fullPage: true,
    });
    await page
      .getByRole("button", { name: /^Conversation options:/ })
      .first()
      .click();
    await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Conversation name" })
      .fill("实际文件任务");
    await page.getByRole("button", { name: "Save name", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "实际文件任务", exact: true }),
    ).toBeVisible();
    // Delay the first session's availability check to exercise pending-send isolation.
    await app.evaluate(async (_electron, mainUrl) => {
      const vm = process.getBuiltinModule("node:vm");
      const imported = await vm.runInThisContext(
        `import(${JSON.stringify(mainUrl)})`,
        {
          importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
        },
      );
      const runtime = imported.agents.modelRuntime;
      const original = runtime.getAvailable.bind(runtime);
      let delayed = false;
      runtime.getAvailable = async (...args: unknown[]) => {
        if (!delayed && args[0] === "worklens-test") {
          delayed = true;
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
        return original(...args);
      };
    }, mainUrl);
    await page.getByRole("button", { name: /New chat/ }).click();
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("SLOW 会话甲 " + "进行中 ".repeat(100));
    await page.getByRole("button", { name: "Send message" }).click();
    await page.getByRole("button", { name: /New chat/ }).click();
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("并发会话乙");
    await expect(
      page.getByRole("button", { name: "Send message" }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Send message" }).click();
    await finished();
    await expect(page.locator(".aui-thread-root")).not.toContainText("SLOW");
    await page
      .locator(".conversation-open")
      .filter({ hasText: "SLOW 会话甲" })
      .click();
    await page.getByRole("button", { name: "Stop task" }).click();
    await finished("Cancelled");
    await page
      .locator(".conversation-open")
      .filter({ hasText: "并发会话乙" })
      .click();
    await finished();
    await page
      .locator(".conversation-open")
      .filter({ hasText: "实际文件任务" })
      .click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Close settings" }).click();
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("继续这个历史会话");
    await page.getByRole("button", { name: "Send message" }).click();
    await finished();
    await expect(page.locator(".aui-thread-root")).toContainText(
      "继续这个历史会话",
    );
    await expect(
      page.getByRole("heading", { name: "实际文件任务", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "General", exact: true }).click();
    await page
      .getByRole("combobox", { name: "Appearance", exact: true })
      .selectOption("dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.screenshot({
      path: "test-results/settings-dark.png",
      fullPage: true,
    });
    await app.close();
    app = undefined;
    const second = await launch();
    app = second.instance;
    if (
      await second.window
        .getByRole("button", { name: "Close settings", exact: true })
        .isVisible()
    )
      await second.window
        .getByRole("button", { name: "Close settings", exact: true })
        .click();
    await second.window
      .locator(".conversation-open")
      .filter({ hasText: "实际文件任务" })
      .click();
    await second.window
      .locator('[data-slot="reasoning-trigger"]')
      .first()
      .click();
    await second.window
      .locator('[data-slot="tool-fallback-trigger"]')
      .first()
      .click();
    await expect(
      second.window.locator('[data-slot="tool-fallback-root"]'),
    ).toContainText(target);
    await expect(
      second.window.getByRole("heading", { name: "实际文件任务", exact: true }),
    ).toBeVisible();
    await expect(second.window.locator("html")).toHaveAttribute(
      "data-theme",
      "dark",
    );
    await second.window.screenshot({
      path: "test-results/restored-dark.png",
      fullPage: true,
    });
    await expect(second.window.locator(".aui-thread-root")).toContainText(
      "继续这个历史会话",
    );
    await second.window
      .getByRole("button", {
        name: "Conversation options: 并发会话乙",
        exact: true,
      })
      .click();
    await second.window
      .getByRole("menuitem", { name: "Delete", exact: true })
      .click();
    await second.window
      .getByRole("dialog", { name: "Delete conversation?" })
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await expect(
      second.window
        .locator(".conversation-open")
        .filter({ hasText: "并发会话乙" }),
    ).toHaveCount(0);
    await expect(
      second.window.getByRole("heading", { name: "实际文件任务", exact: true }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await app?.close();
    await server.close();
  }
});
