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
import { githubFixture } from "../../connectors/github/fixture";
import { mockServer, fixtureModel } from "../../mock-server";

test("GitHub settings, encrypted restart, Pi download and file card", async () => {
  const root = await mkdtemp(join(tmpdir(), "worklens-github-desktop-"));
  const fixture = await githubFixture();
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
    await page.getByRole("button", { name: "Connectors", exact: true }).click();
    await page
      .getByRole("button", { name: "Connect GitHub", exact: true })
      .click();
    await expect(page.locator("#github-access")).toHaveCount(0);
    await expect(page.locator("#github-url")).toHaveValue("");
    await page.locator("#github-url").fill(fixture.url);
    await page.locator("#github-token").fill("synthetic-desktop-token");
    // Save must validate even when the optional test button has never been used.
    fixture.state.identityStatus = 401;
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Check your token and account.", { exact: true }).first()).toBeVisible();
    const invalid = await page.evaluate(() =>
      window.worklens.invoke("bootstrap", undefined),
    );
    expect(invalid.github?.configured).toBe(false);
    expect(invalid.tools).not.toContain("github_read");
    expect(invalid.tools).not.toContain("github_write");
    fixture.state.identityStatus = 200;
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Manage GitHub", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Manage GitHub", exact: true })
      .click();
    await expect(page.locator("#github-token")).toHaveValue("");
    await page
      .getByRole("button", { name: "Test connection", exact: true })
      .click();
    await expect(page.locator('[data-slot="toast-description"]').filter({ hasText: "fixture-user" })).toBeVisible();
    await page.screenshot({
      path: "test-results/github-dialog.png",
      fullPage: true,
    });
    await page.keyboard.press("Escape");
    expect(
      await readFile(join(root, "app", "github.json"), "utf8"),
    ).not.toContain("synthetic-desktop-token");
    expect(
      JSON.stringify(
        await page.evaluate(() =>
          window.worklens.invoke("bootstrap", undefined),
        ),
      ),
    ).not.toContain("synthetic-desktop-token");
    await page.screenshot({
      path: "test-results/github-settings.png",
      fullPage: true,
    });
    await app!.close();
    page = await launch();
    const saved = await page.evaluate(() =>
      window.worklens.invoke("bootstrap", undefined),
    );
    expect(saved.github?.configured).toBe(true);
    expect(saved.github).not.toHaveProperty("access");
    expect(saved.tools).toContain("github_write");
    expect(saved.github?.url).toBe(fixture.url);
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
        requestId: "download-github-fixture",
        text: 'TOOL {"name":"github_read","args":{"request":{"operation":"download_file","repo":"o/r","path":"README.md","ref":"main"}}}',
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
    const artifact = finished.messages.find((m) => m.toolName === "github_read")
      ?.artifacts?.[0];
    expect(artifact).toBeTruthy();
    expect(await readFile(artifact!.path, "utf8")).toBe("fixture file bytes");
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Save as", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: "test-results/github-download.png",
      fullPage: true,
    });
    const writeRun = await page.evaluate(() =>
      window.worklens.invoke("send", {
        requestId: "write-github-fixture",
        text: 'TOOL {"name":"github_write","args":{"request":{"operation":"add_comment","repo":"o/r","issue_number":1,"body":"desktop write"}}}',
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
              writeRun.id,
            )
          ).phase,
      )
      .toBe("completed");
    const written = await page.evaluate(
      (id) => window.worklens.invoke("open", { id }),
      writeRun.id,
    );
    expect(
      written.messages.find((m) => m.toolName === "github_write")?.status,
    ).toBe("success");
    expect(fixture.state.comments).toBe(1);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Connectors", exact: true }).click();
    await page
      .getByRole("button", { name: "Manage GitHub", exact: true })
      .click();
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Disconnect GitHub?", exact: true })
      .getByRole("button", { name: "Disconnect", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (
            await page.evaluate(() =>
              window.worklens.invoke("bootstrap", undefined),
            )
          ).github?.configured,
      )
      .toBe(false);
    expect(await readFile(artifact!.path, "utf8")).toBe("fixture file bytes");
  } finally {
    await app?.close();
    await modelServer.close();
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});
