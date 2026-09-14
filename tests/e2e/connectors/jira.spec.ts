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
import { jiraFixture } from "../../connectors/jira/fixture";
import { mockServer, fixtureModel } from "../../mock-server";

test("Jira settings, encrypted restart, Pi download and file card", async () => {
  const root = await mkdtemp(join(tmpdir(), "worklens-jira-desktop-"));
  const fixture = await jiraFixture();
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
      .getByRole("button", { name: "Connect Jira", exact: true })
      .click();
    await expect(page.locator("#jira-access")).toHaveCount(0);
    await page.locator("#jira-url").fill(fixture.url);
    await page.locator("#jira-token").fill("synthetic-desktop-token");
    // Save must validate even when the optional test button has never been used.
    fixture.state.identityStatus = 401;
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText(/Jira 返回 401/).first()).toBeVisible();
    const invalid = await page.evaluate(() =>
      window.worklens.invoke("bootstrap", undefined),
    );
    expect(invalid.jira?.configured).toBe(false);
    expect(invalid.tools).not.toContain("jira_read");
    expect(invalid.tools).not.toContain("jira_write");
    fixture.state.identityStatus = 200;
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Manage Jira", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Manage Jira", exact: true })
      .click();
    await expect(page.locator("#jira-token")).toHaveValue("");
    await page
      .getByRole("button", { name: "Test connection", exact: true })
      .click();
    await expect(page.getByText(/Fixture User/)).toBeVisible();
    await page.screenshot({
      path: "test-results/jira-dialog.png",
      fullPage: true,
    });
    await page.keyboard.press("Escape");
    expect(
      await readFile(join(root, "app", "jira.json"), "utf8"),
    ).not.toContain("synthetic-desktop-token");
    expect(
      JSON.stringify(
        await page.evaluate(() =>
          window.worklens.invoke("bootstrap", undefined),
        ),
      ),
    ).not.toContain("synthetic-desktop-token");
    await page.screenshot({
      path: "test-results/jira-settings.png",
      fullPage: true,
    });
    await app!.close();
    page = await launch();
    const saved = await page.evaluate(() =>
      window.worklens.invoke("bootstrap", undefined),
    );
    expect(saved.jira?.configured).toBe(true);
    expect(saved.jira).not.toHaveProperty("access");
    expect(saved.tools).toContain("jira_write");
    expect(saved.jira?.url).toBe(fixture.url);
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
        requestId: "download-jira-fixture",
        text: 'TOOL {"name":"jira_read","args":{"request":{"operation":"download_attachment","attachment":"8"}}}',
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
    const artifact = finished.messages.find((m) => m.toolName === "jira_read")
      ?.artifacts?.[0];
    expect(artifact).toBeTruthy();
    expect(await readFile(artifact!.path, "utf8")).toBe(
      "fixture attachment bytes",
    );
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Save as", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: "test-results/jira-download.png",
      fullPage: true,
    });
    const writeRun = await page.evaluate(() =>
      window.worklens.invoke("send", {
        requestId: "write-jira-fixture",
        text: 'TOOL {"name":"jira_write","args":{"request":{"operation":"add_comment","issue":"TEST-1","body":{"format":"markdown","text":"desktop write without approval"}}}}',
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
      written.messages.find((m) => m.toolName === "jira_write")?.status,
    ).toBe("success");
    expect(fixture.state.commentCount).toBe(1);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByRole("button", { name: "Connections", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Manage Jira", exact: true })
      .click();
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    await expect
      .poll(
        async () =>
          (
            await page.evaluate(() =>
              window.worklens.invoke("bootstrap", undefined),
            )
          ).jira?.configured,
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
