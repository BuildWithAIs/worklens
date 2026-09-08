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
    const window = await instance.firstWindow();
    window.on("pageerror", (error) => errors.push(error.message));
    await expect(
      window.getByRole("button", { name: /新建会话/ }),
    ).toBeVisible();
    console.log(
      `Electron fresh process to interactive: ${(performance.now() - launchedAt).toFixed(0)} ms`,
    );
    return { instance, window };
  };
  try {
    const first = await launch();
    app = first.instance;
    const page = first.window;
    await expect(page.getByText("Pi 内置 · WorkLens 尚未实测")).toBeVisible();
    expect(await page.evaluate(() => typeof (window as any).require)).toBe(
      "undefined",
    );
    await page.screenshot({
      path: "test-results/onboarding-light.png",
      fullPage: true,
    });
    await page.getByRole("textbox", { name: "查找服务商" }).fill("OpenAI");
    await page.getByRole("button", { name: "OpenAI", exact: true }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "无法读取或解密" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "配置 · OpenAI API key", exact: true })
      .click();
    await page
      .locator("dialog input[type=password]")
      .fill("worklens-placeholder-credential-for-test");
    await page.getByRole("button", { name: "继续", exact: true }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(
      page.getByRole("alert").filter({ hasText: "无法读取或解密" }),
    ).not.toBeVisible();
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
    await page.getByRole("button", { name: "刷新状态", exact: true }).click();
    await page
      .getByRole("combobox", { name: "模型服务商" })
      .selectOption("worklens-test");
    await page.getByRole("button", { name: "保存默认模型" }).click();
    await page.getByRole("button", { name: "测试连接", exact: true }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "连接成功" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "返回对话" }).click();
    await page.getByRole("button", { name: /新建会话/ }).click();
    await expect(
      page.getByRole("heading", { name: "今天，我们从哪里开始？" }),
    ).toBeVisible();
    await page.screenshot({
      path: "test-results/chat-empty-light.png",
      fullPage: true,
    });
    const target = join(directory, "actual-file.txt");
    await page.getByRole("textbox", { name: "消息", exact: true }).fill(
      "TOOL " +
        JSON.stringify({
          name: "write",
          args: { path: target, content: "WorkLens Electron 实测成功" },
        }),
    );
    await page.getByRole("button", { name: "发送消息" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator(".run-status")).toHaveText(/已完成/, {
      timeout: 30000,
    });
    expect(await readFile(target, "utf8")).toBe("WorkLens Electron 实测成功");
    await expect(page.locator(".tool-card.success")).toBeVisible();
    await page.locator(".tool-card summary").click();
    await expect(page.locator(".tool-detail")).toContainText(target);
    await expect(page.locator(".tool-detail")).toContainText("开始时间：");
    await page.screenshot({
      path: "test-results/tool-task-light.png",
      fullPage: true,
    });
    await page
      .getByRole("button", { name: /^重命名 / })
      .first()
      .click();
    await page.getByRole("textbox", { name: "会话名称" }).fill("实际文件任务");
    await page.getByRole("button", { name: "保存名称" }).click();
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
    await page.getByRole("button", { name: /新建会话/ }).click();
    await page
      .getByRole("textbox", { name: "消息", exact: true })
      .fill("SLOW 会话甲 " + "进行中 ".repeat(100));
    await page.getByRole("button", { name: "发送消息" }).click();
    await page.getByRole("button", { name: /新建会话/ }).click();
    await page
      .getByRole("textbox", { name: "消息", exact: true })
      .fill("并发会话乙");
    await expect(page.getByRole("button", { name: "发送消息" })).toBeEnabled();
    await page.getByRole("button", { name: "发送消息" }).click();
    await expect(page.locator(".run-status")).toHaveText(/已完成/);
    await expect(page.locator(".messages")).not.toContainText("SLOW");
    await page
      .locator(".conversation-open")
      .filter({ hasText: "SLOW 会话甲" })
      .click();
    await page.getByRole("button", { name: "停止运行" }).click();
    await expect(page.locator(".run-status")).toHaveText(/已取消/);
    await page
      .locator(".conversation-open")
      .filter({ hasText: "并发会话乙" })
      .click();
    await expect(page.locator(".run-status")).toHaveText(/已完成/);
    await page
      .locator(".conversation-open")
      .filter({ hasText: "实际文件任务" })
      .click();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "返回对话" }).click();
    await page
      .getByRole("textbox", { name: "消息", exact: true })
      .fill("继续这个历史会话");
    await page.getByRole("button", { name: "发送消息" }).click();
    await expect(page.locator(".run-status")).toHaveText(/已完成/, {
      timeout: 30000,
    });
    await expect(page.locator(".messages")).toContainText("继续这个历史会话");
    await expect(
      page.getByRole("heading", { name: "实际文件任务", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "深色", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.screenshot({
      path: "test-results/settings-dark.png",
      fullPage: true,
    });
    await app.close();
    app = undefined;
    const second = await launch();
    app = second.instance;
    await second.window
      .locator(".conversation-open")
      .filter({ hasText: "实际文件任务" })
      .click();
    await expect(second.window.locator(".tool-card.success")).toBeVisible();
    await second.window.locator(".tool-card summary").click();
    await expect(second.window.locator(".tool-detail")).toContainText(
      "开始时间：",
    );
    await expect(second.window.locator(".tool-detail")).toContainText("耗时");
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
    await expect(second.window.locator(".messages")).toContainText(
      "继续这个历史会话",
    );
    await second.window
      .getByRole("button", { name: "删除 并发会话乙", exact: true })
      .click();
    await second.window
      .getByRole("button", { name: "永久删除", exact: true })
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
