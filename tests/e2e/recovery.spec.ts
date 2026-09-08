import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
} from "@playwright/test";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { mockServer, fixtureModel } from "../mock-server";

test("PRD 033, 063: forced process death preserves first input without replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "worklens-crash-"));
  const server = await mockServer();
  const env = { ...process.env, WORKLENS_TEST_ROOT: root } as Record<
    string,
    string
  >;
  delete env.ELECTRON_RUN_AS_NODE;
  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({
      args: ["."],
      cwd: resolve("."),
      env,
    });
    const page = await application.firstWindow();
    await expect(page.getByRole("button", { name: /新建会话/ })).toBeVisible();
    await application.evaluate(
      async (_electron, { uri, url, model }) => {
        const vm = process.getBuiltinModule("node:vm");
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
      {
        uri: pathToFileURL(resolve("dist/main/index.js")).href,
        url: server.url,
        model: fixtureModel,
      },
    );
    await page.evaluate(() =>
      window.worklens.invoke("settings", { riskAccepted: true }),
    );
    const text = "SLOW 保留这条已提交但尚未落盘的任务 " + "处理中 ".repeat(120);
    const view = await page.evaluate(
      (text) =>
        window.worklens.invoke("send", {
          text,
          requestId: crypto.randomUUID(),
          selection: {
            provider: "worklens-test",
            model: "worklens-test",
            thinking: "off",
          },
        }),
      text,
    );
    await expect.poll(() => server.requests.length).toBe(1);
    expect((await readdir(join(root, "sessions"))).length).toBe(0);
    const pending = JSON.parse(
      await readFile(
        join(root, "app", "runs", `${view.runId}.pending.json`),
        "utf8",
      ),
    );
    expect(pending.text).toBe(text);
    const child = application.process();
    if (process.platform === "win32")
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
    else child.kill("SIGKILL");
    await expect.poll(() => child.exitCode !== null).toBe(true);
    application = undefined;
    application = await electron.launch({
      args: ["."],
      cwd: resolve("."),
      env,
    });
    const restored = await application.firstWindow();
    await expect(
      restored.getByRole("heading", { name: "上次有任务意外中断" }),
    ).toBeVisible();
    await restored
      .getByRole("button", { name: "载入草稿，核对后继续" })
      .click();
    await expect(
      restored.getByRole("textbox", { name: "消息", exact: true }),
    ).toHaveValue(text);
    expect(server.requests.length).toBe(1);
    await restored.screenshot({
      path: "test-results/recovered-draft.png",
      fullPage: true,
    });
  } finally {
    await application?.close();
    await server.close();
  }
});
