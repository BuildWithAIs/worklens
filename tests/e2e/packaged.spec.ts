import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { mockServer, fixtureModel } from "../mock-server";

test("PRD 063, 17.5: packaged Windows ASAR runtime and PowerShell smoke", async () => {
  test.skip(
    !process.env.WORKLENS_PACKAGED_EXE,
    "Run after packaging with WORKLENS_PACKAGED_EXE set",
  );
  const root = await mkdtemp(join(tmpdir(), "worklens-packaged-"));
  const vault = join(root, "app", "credentials");
  await mkdir(vault, { recursive: true });
  await writeFile(
    join(vault, createHash("sha256").update("openai").digest("hex") + ".json"),
    "{corrupt-packaged-vault",
  );
  const env: NodeJS.ProcessEnv = { ...process.env, WORKLENS_TEST_ROOT: root };
  delete env.ELECTRON_RUN_AS_NODE;
  const server = await mockServer();
  const application = await electron.launch({
    executablePath: resolve(process.env.WORKLENS_PACKAGED_EXE!),
    args: [],
    env: env as Record<string, string>,
  });
  try {
    const page = await application.firstWindow();
    await expect(
      page.getByRole("heading", { name: "模型服务", exact: true }),
    ).toBeVisible();
    const bootstrap = await page.evaluate(() =>
      window.worklens.invoke("bootstrap", undefined),
    );
    expect(bootstrap.paths.root.toLowerCase()).toBe(root.toLowerCase());
    expect(bootstrap.providers.length).toBeGreaterThan(30);
    expect(
      bootstrap.providers.find((provider) => provider.id === "openai")
        ?.credentialError,
    ).toContain("原文件尚未修改");
    const runtimeInfo = await application.evaluate(
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
          name: "打包测试服务",
          api: "openai-completions",
          baseUrl: url,
          apiKey: "fixture",
          models: [model],
        });
        await imported.agents.modelRuntime.refresh({ allowNetwork: false });
        return {
          packaged: app.isPackaged,
          node: process.versions.node,
          electron: process.versions.electron,
        };
      },
      { url: server.url, model: fixtureModel },
    );
    expect(runtimeInfo.packaged).toBe(true);
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
    const target = join(root, "packaged-result.txt");
    const command = `Set-Content -LiteralPath '${target.replaceAll("'", "''")}' -Value 'PACKAGED_OK'; Get-Content -LiteralPath '${target.replaceAll("'", "''")}'`;
    const conversation = await page.evaluate(
      ({ selection, command }) =>
        window.worklens.invoke("send", {
          selection,
          requestId: crypto.randomUUID(),
          text:
            "TOOL " +
            JSON.stringify({
              name: "powershell",
              args: { command, timeout: 10 },
            }),
        }),
      { selection, command },
    );
    await expect
      .poll(
        async () =>
          (
            await page.evaluate(
              (id) => window.worklens.invoke("open", { id }),
              conversation.id,
            )
          ).phase,
        { timeout: 30000 },
      )
      .toBe("completed");
    expect(await readFile(target, "utf8")).toContain("PACKAGED_OK");
    await page.getByRole("button", { name: "返回对话" }).click();
    await page.locator(".conversation-open").first().click();
    await expect(page.locator(".tool-card.success")).toBeVisible();
    await page.locator(".tool-card.success summary").click();
    await expect(page.getByText("命令初始目录", { exact: true })).toBeVisible();
    await expect(page.getByText("超时：10 秒 · 退出码：0")).toBeVisible();
    await page.screenshot({
      path: "test-results/packaged-windows.png",
      fullPage: true,
    });
    console.log(
      `Packaged runtime: Electron ${runtimeInfo.electron}, Node ${runtimeInfo.node}`,
    );
  } finally {
    await application.close();
    await server.close();
  }
});
