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
import { confluenceFixture } from "../confluence-fixture";
import { mockServer, fixtureModel } from "../mock-server";

test("Confluence settings, encrypted restart, Pi download and file card", async () => {
  const root = await mkdtemp(join(tmpdir(), "worklens-confluence-desktop-"));
  const fixture = await confluenceFixture();
  const modelServer = await mockServer();
  let app: ElectronApplication | undefined;
  const env: NodeJS.ProcessEnv = { ...process.env, WORKLENS_TEST_ROOT: root };
  delete env.ELECTRON_RUN_AS_NODE;
  // Keep onboarding and local model tests independent of developer credentials.
  for (const key of Object.keys(env))
    if (/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|GITHUB_TOKEN|GH_TOKEN)$/.test(key))
      delete env[key];
  const launch = async () => {
    app = await electron.launch({
      args: ["."],
      cwd: resolve("."),
      env: env as Record<string, string>,
    });
    return app.firstWindow();
  };
  try {
    let page = await launch();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByRole("button", { name: "Connections", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Connect Confluence", exact: true })
      .click();
    await page.locator("#confluence-url").fill(fixture.url);
    await page.locator("#confluence-token").fill("synthetic-desktop-token");
    await page
      .getByRole("button", { name: "Test connection", exact: true })
      .click();
    await expect(page.getByText(/Fixture User/)).toBeVisible();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Manage Confluence", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Manage Confluence", exact: true })
      .click();
    await expect(page.locator("#confluence-token")).toHaveValue("");
    await page.screenshot({
      path: "test-results/confluence-dialog.png",
      fullPage: true,
    });
    await page.keyboard.press("Escape");
    expect(
      await readFile(join(root, "app", "confluence.json"), "utf8"),
    ).not.toContain("synthetic-desktop-token");
    expect(
      JSON.stringify(
        await page.evaluate(() =>
          window.worklens.invoke("bootstrap", undefined),
        ),
      ),
    ).not.toContain("synthetic-desktop-token");
    await page.screenshot({
      path: "test-results/confluence-settings.png",
      fullPage: true,
    });
    await app!.close();
    page = await launch();
    const saved = await page.evaluate(() =>
      window.worklens.invoke("bootstrap", undefined),
    );
    expect(saved.confluence?.configured).toBe(true);
    expect(saved.confluence?.url).toBe(fixture.url);
    await app!.evaluate(
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
          name: "Fixture",
          api: "openai-completions",
          baseUrl: url,
          apiKey: "synthetic",
          models: [model],
        });
        await imported.agents.modelRuntime.refresh({ allowNetwork: false });
      },
      {
        mainUrl: pathToFileURL(resolve("dist/main/index.js")).href,
        url: modelServer.url,
        model: fixtureModel,
      },
    );
    const started = await page.evaluate(() =>
      window.worklens.invoke("send", {
        requestId: "download-confluence-fixture",
        text: 'TOOL {"name":"confluence_read","args":{"request":{"operation":"download_attachment","attachmentId":"8"}}}',
        selection: {
          provider: "worklens-test",
          model: "worklens-test",
          thinking: "off",
        },
      }),
    );
    await expect
      .poll(
        async () =>
          (
            await page.evaluate(
              (id) => window.worklens.invoke("open", { id }),
              started.id,
            )
          ).phase,
      )
      .toBe("completed");
    const finished = await page.evaluate(
      (id) => window.worklens.invoke("open", { id }),
      started.id,
    );
    const artifact = finished.messages.find(
      (m) => m.toolName === "confluence_read",
    )?.artifacts?.[0];
    expect(artifact).toBeTruthy();
    expect(await readFile(artifact!.path, "utf8")).toBe(
      "fixture attachment bytes",
    );
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Save as", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: "test-results/confluence-download.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByRole("button", { name: "Connections", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Manage Confluence", exact: true })
      .click();
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    await expect
      .poll(
        async () =>
          (
            await page.evaluate(() =>
              window.worklens.invoke("bootstrap", undefined),
            )
          ).confluence?.configured,
      )
      .toBe(false);
    expect(await readFile(artifact!.path, "utf8")).toBe(
      "fixture attachment bytes",
    );
  } finally {
    await app?.close();
    await modelServer.close();
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});
