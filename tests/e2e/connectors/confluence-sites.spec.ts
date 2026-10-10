import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { confluenceFixture } from "../../connectors/confluence/fixture";
import { mockServer, fixtureModel } from "../../mock-server";

test("Confluence sites keep separate credentials and read-only state through real tools and restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "worklens-confluence-sites-"));
  const a = await confluenceFixture();
  const b = await confluenceFixture();
  const modelServer = await mockServer();
  let app: ElectronApplication | undefined;
  const env: NodeJS.ProcessEnv = { ...process.env, WORKLENS_TEST_ROOT: root };
  delete env.ELECTRON_RUN_AS_NODE;
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
  const registerModel = () =>
    app!.evaluate(
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
  // Runs one tool call through the real agent session and returns its message.
  const tool = async (page: Page, name: string, request: object) => {
    const run = await page.evaluate(
      (text) =>
        window.worklens.invoke("send", {
          requestId: crypto.randomUUID(),
          text,
          selection: {
            provider: "worklens-test",
            model: "worklens-test",
            thinking: "off",
          },
        }),
      `TOOL ${JSON.stringify({ name, args: { request } })}`,
    );
    await expect
      .poll(
        async () =>
          (
            await page.evaluate(
              (id) => window.worklens.invoke("open", { id }),
              run.id,
            )
          ).phase,
      )
      .toBe("completed");
    const view = await page.evaluate(
      (id) => window.worklens.invoke("open", { id }),
      run.id,
    );
    return view.messages.find((message) => message.toolName === name);
  };
  try {
    let page = await launch();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Connectors", exact: true }).click();
    const dialog = page.getByRole("dialog", {
      name: "Confluence",
      exact: true,
    });
    await page
      .getByRole("button", { name: "Connect Confluence", exact: true })
      .click();
    await dialog.locator("#confluence-url").fill(a.url);
    await dialog.locator("#confluence-token").fill("synthetic-desktop-a");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await page
      .getByRole("button", { name: "Add Confluence site", exact: true })
      .click();
    await dialog.locator("#confluence-url").fill(b.url);
    await dialog.locator("#confluence-token").fill("synthetic-desktop-b");
    await dialog.getByRole("switch", { name: "Read-only" }).click();
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await page.screenshot({
      path: "test-results/confluence-sites.png",
      fullPage: true,
    });
    await registerModel();

    const download = await tool(page, "confluence_read", {
      operation: "download_attachment",
      attachmentId: "8",
      site: b.url,
    });
    expect(download?.artifacts?.[0]).toBeTruthy();
    expect(await readFile(download!.artifacts![0].path, "utf8")).toBe(
      "fixture attachment bytes",
    );
    const blocked = await tool(page, "confluence_write", {
      operation: "add_comment",
      page: "1",
      content: "must not reach the read-only site",
      site: b.url,
    });
    expect(blocked?.status).toBe("error");
    expect(b.state.commentCount).toBe(0);
    // The only writable site needs no site argument.
    const written = await tool(page, "confluence_write", {
      operation: "add_comment",
      page: "1",
      content: "desktop write",
    });
    expect(written?.status).toBe("success");
    expect(a.state.commentCount).toBe(1);
    expect(
      a.requests.every((r) => r.authorization === "Bearer synthetic-desktop-a"),
    ).toBe(true);
    expect(
      b.requests.every((r) => r.authorization === "Bearer synthetic-desktop-b"),
    ).toBe(true);

    await app!.close();
    page = await launch();
    await registerModel();
    const saved = await page.evaluate(() =>
      window.worklens.invoke("bootstrap", undefined),
    );
    expect(
      saved.confluenceSites?.map(({ url, readOnly, configured }) => ({
        url,
        readOnly,
        configured,
      })),
    ).toEqual([
      { url: a.url, readOnly: false, configured: true },
      { url: b.url, readOnly: true, configured: true },
    ]);
    expect(saved.tools).toEqual(
      expect.arrayContaining(["confluence_read", "confluence_write"]),
    );
    const ambiguous = await tool(page, "confluence_read", {
      operation: "current_user",
    });
    expect(ambiguous?.status).toBe("error");
    const files = [
      join(root, "app", "confluence.json"),
      join(root, "app", "confluence-sites.json"),
      ...(await readdir(join(root, "app", "confluence-sites"))).map((name) =>
        join(root, "app", "confluence-sites", name),
      ),
    ];
    expect(files).toHaveLength(3);
    for (const file of files) {
      const text = await readFile(file, "utf8");
      expect(text).not.toContain("synthetic-desktop-a");
      expect(text).not.toContain("synthetic-desktop-b");
    }
    expect(JSON.stringify(saved)).not.toContain("synthetic-desktop");
  } finally {
    await app?.close().catch(() => {});
    await a.close();
    await b.close();
    await modelServer.close();
    await rm(root, { recursive: true, force: true });
  }
});
