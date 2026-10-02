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
    await expect(page.locator(".sidebar")).toBeVisible();
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
          models: [{ ...model, input: ["text", "image"] }],
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
    const text = "SLOW 保留这条已提交但尚未完成的任务 " + "处理中 ".repeat(120);
    const view = await page.evaluate(
      (text) =>
        window.worklens.invoke("send", {
          text,
          images: [
            {
              name: "recovered.png",
              mimeType: "image/png",
              data: "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGNoCX0HRwzEcQDdEhxxGEJJKQAAAABJRU5ErkJggg==",
            },
          ],
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
    // Pi now flushes the first user message before starting the model request.
    const sessions = (await readdir(join(root, "sessions"))).filter((file) =>
      file.endsWith(".jsonl"),
    );
    expect(sessions).toHaveLength(1);
    const entries = (
      await readFile(join(root, "sessions", sessions[0]), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      entries.filter((entry) => entry.message?.role === "user"),
    ).toHaveLength(1);
    expect(entries.some((entry) => entry.message?.role === "assistant")).toBe(
      false,
    );
    const pending = JSON.parse(
      await readFile(
        join(root, "app", "runs", `${view.runId}.pending.json`),
        "utf8",
      ),
    );
    expect(pending.text).toBe(text);
    expect(pending.images[0].name).toBe("recovered.png");
    const child = application.process();
    if (process.platform === "win32")
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
    else child.kill("SIGKILL");
    await expect
      .poll(() => child.exitCode !== null || child.signalCode !== null)
      .toBe(true);
    application = undefined;
    application = await electron.launch({
      args: ["."],
      cwd: resolve("."),
      env,
    });
    const restored = await application.firstWindow();
    await expect(
      restored.getByRole("heading", {
        name: "An earlier task was interrupted",
      }),
    ).toBeVisible();
    await restored
      .getByRole("button", { name: "Load draft for review" })
      .click();
    await expect(
      restored.getByRole("textbox", { name: "Message", exact: true }),
    ).toHaveValue(text);
    await expect(restored.locator(".aui-composer-attachments img")).toHaveCount(
      1,
    );
    await expect(
      restored.locator(".aui-composer-attachments img"),
    ).toHaveJSProperty("naturalWidth", 4);
    expect(server.requests.length).toBe(1);
    const reopened = await restored.evaluate(
      (id) => window.worklens.invoke("open", { id }),
      view.id,
    );
    expect(
      reopened.messages.filter((message) => message.role === "user"),
    ).toHaveLength(1);
    await restored.screenshot({
      path: "test-results/recovered-draft.png",
      fullPage: true,
    });
  } finally {
    await application?.close();
    await server.close();
  }
});
