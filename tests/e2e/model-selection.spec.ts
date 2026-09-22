import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fixtureModel } from "../mock-server";

test("model catalog discovery and management persist through real IPC and app restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "worklens-model-e2e-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WORKLENS_TEST_ROOT: directory,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) {
    if (/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|GITHUB_TOKEN|GH_TOKEN)$/.test(key))
      delete env[key];
  }
  const launch = () =>
    electron.launch({
      args: ["."],
      cwd: resolve("."),
      env: env as Record<string, string>,
    });
  let app = await launch();
  const register = async (ids: string[]) => {
    await app.evaluate(
      async (_electron, { mainUrl, ids, model }) => {
        const vm = process.getBuiltinModule("node:vm");
        const imported = await vm.runInThisContext(
          `import(${JSON.stringify(mainUrl)})`,
          {
            importModuleDynamically:
              vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
          },
        );
        imported.agents.modelRuntime.registerProvider("worklens-test", {
          name: "Local model catalog",
          api: "openai-completions",
          baseUrl: "http://127.0.0.1:1",
          apiKey: "test-placeholder",
          models: ids.map((id) => ({ ...model, id, name: id })),
        });
        await imported.agents.modelRuntime.refresh({ allowNetwork: false });
      },
      {
        mainUrl: pathToFileURL(resolve("dist/main/index.js")).href,
        ids,
        model: fixtureModel,
      },
    );
  };
  try {
    let page = await app.firstWindow();
    await expect(page.locator(".sidebar")).toBeVisible();
    await register(["original"]);
    let data = await page.evaluate(() =>
      window.worklens.invoke("bootstrap", undefined),
    );
    expect(data.settings.modelCatalogs?.["worklens-test"]).toEqual({
      known: ["original"],
      new: [],
    });
    expect(data.settings.hiddenModels).not.toContain("worklens-test/original");
    await register(["original", "new-model"]);
    data = await page.evaluate(() =>
      window.worklens.invoke("bootstrap", undefined),
    );
    expect(data.settings.hiddenModels).toContain("worklens-test/new-model");
    expect(data.settings.modelCatalogs?.["worklens-test"].new).toEqual([
      "new-model",
    ]);
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await expect(page.locator(".sidebar")).toBeVisible();
    await register(["original", "new-model"]);
    data = await page.evaluate(() =>
      window.worklens.invoke("bootstrap", undefined),
    );
    expect(data.settings.modelCatalogs?.["worklens-test"].new).toEqual([
      "new-model",
    ]);
    await page.reload();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Models", exact: true }).click();
    await expect(page.getByText("new-model", { exact: true })).toHaveCount(0);
    await page
      .getByRole("button", {
        name: "Select models: Local model catalog",
        exact: true,
      })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Local model catalog models",
      exact: true,
    });
    await expect(
      dialog.getByRole("checkbox", { name: "original", exact: true }),
    ).toBeVisible();
    await expect(dialog.getByText("New", { exact: true })).toHaveCount(1);
    await expect(
      dialog.getByRole("checkbox", { name: "new-model", exact: true }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toBeHidden();
    data = await page.evaluate(() =>
      window.worklens.invoke("bootstrap", undefined),
    );
    expect(data.settings.modelCatalogs?.["worklens-test"].new).toEqual([]);
    expect(data.settings.hiddenModels).toContain("worklens-test/new-model");
  } finally {
    await app.close();
  }
});
