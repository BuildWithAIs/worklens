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
import { jevFixture, sample, secret } from "../../connectors/jev/fixture";
import { mockServer, fixtureModel } from "../../mock-server";

test("Jev desktop consent controls real Pi traffic and chat permission survives restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "worklens-jev-desktop-"));
  const fixture = await jevFixture();
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
  const evaluations = () =>
    fixture.state.requests.filter(({ path }) => path === "/v1/systemone");
  try {
    let page = await launch();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Connectors", exact: true }).click();
    await page
      .getByRole("button", { name: "Connect Jev", exact: true })
      .click();
    await page.locator("#jev-url").fill(fixture.url);
    await page.locator("#jev-token").fill(secret);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Manage Jev", exact: true }),
    ).toBeVisible();
    expect(evaluations()).toHaveLength(0);
    const credentials = await readFile(join(root, "app", "jev.json"), "utf8");
    expect(credentials).not.toContain(secret);
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
          name: "Local fixture",
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
    const selection = {
      provider: "worklens-test",
      model: "worklens-test",
      thinking: "off" as const,
    };
    const started = await page.evaluate(
      ({ selection, sample }) =>
        window.worklens.invoke("send", {
          requestId: "first-batch",
          text: `TOOL ${JSON.stringify({ name: "jev_classify", args: sample })}`,
          selection,
        }),
      { selection, sample },
    );
    await page
      .getByRole("button", { name: "Back to app", exact: true })
      .click();
    await page.reload();
    await page
      .getByRole("navigation", { name: "Conversations" })
      .getByRole("button", { name: started.title, exact: true })
      .click();
    const card = page.locator('[data-slot="jev-approval"]');
    await expect(card).toBeVisible();
    expect(evaluations()).toHaveLength(0);
    const pending = await page.evaluate(
      (id) => window.worklens.invoke("open", { id }),
      started.id,
    );
    await card
      .getByRole("button", {
        name: "View details",
        exact: true,
      })
      .click();
    await expect(card).toContainText(sample.items[0].text);
    await card.getByRole("button", { name: "Allow", exact: true }).click();
    await expect(card).toHaveCount(0);
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
    expect(evaluations()).toHaveLength(1);
    expect(evaluations()[0].raw).toBe(pending.jevConsent!.pending[0].payload);

    // A changed criterion creates a new card in the same live conversation.
    const changed = {
      ...sample,
      categories: [
        { id: "product", description: "Different standard" },
        sample.categories[1],
      ],
    };
    await page.evaluate(
      ({ id, selection, changed }) =>
        window.worklens.invoke("send", {
          conversationId: id,
          requestId: "changed-batch",
          text: `TOOL ${JSON.stringify({ name: "jev_classify", args: changed })}`,
          selection,
        }),
      { id: started.id, selection, changed },
    );
    await expect(card).toBeVisible();
    expect(evaluations()).toHaveLength(1);
    await card
      .getByRole("checkbox", { name: "Always allow in this chat", exact: true })
      .check();
    await card.getByRole("button", { name: "Allow", exact: true }).click();
    const finished = async () =>
      (
        await page.evaluate(
          (id) => window.worklens.invoke("open", { id }),
          started.id,
        )
      ).phase;
    await expect.poll(finished).toBe("completed");
    expect(evaluations()).toHaveLength(2);
    const permission = page.locator('[data-slot="jev-session-access"]');
    await expect(permission).toContainText("Jev · Auto-allow");
    await expect(page.locator('[data-slot="jev-usage"]')).toHaveCount(2);
    await page.locator('[data-slot="jev-usage"]').last().click();
    const popover = page.locator('[data-slot="popover-content"]');
    await expect(popover.locator("pre")).toContainText('"status": "success"');
    await page.keyboard.press("Escape");
    await page.evaluate(
      ({ id, selection, sample }) =>
        window.worklens.invoke("send", {
          conversationId: id,
          requestId: "automatic-batch",
          selection,
          text: `TOOL ${JSON.stringify({ name: "jev_check", args: { items: sample.items, condition: "Mentions a fault" } })}`,
        }),
      { id: started.id, selection, sample },
    );
    await expect.poll(finished).toBe("completed");
    expect(evaluations()).toHaveLength(3);
    await expect(card).toHaveCount(0);
    await expect(page.locator('[data-slot="jev-usage"]')).toHaveCount(3);
    await permission.getByRole("button").click();
    await page
      .getByRole("menuitem", { name: "Ask again", exact: true })
      .click();
    await expect(permission).toHaveCount(0);
    await page.evaluate(
      ({ id, selection, sample }) =>
        window.worklens.invoke("send", {
          conversationId: id,
          requestId: "after-reset",
          selection,
          text: `TOOL ${JSON.stringify({ name: "jev_classify", args: sample })}`,
        }),
      { id: started.id, selection, sample },
    );
    await expect(card).toBeVisible();
    await card
      .getByRole("button", { name: "Disable for this chat", exact: true })
      .click();
    await expect.poll(finished).toBe("completed");
    expect(evaluations()).toHaveLength(3);
    await expect(permission).toContainText("Jev · Disabled");
    await expect(page.locator('[data-slot="jev-usage"]')).toHaveCount(3);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Connectors", exact: true }).click();
    await page.getByRole("button", { name: "Manage Jev", exact: true }).click();
    await expect(
      page.getByRole("dialog", { name: "Jev", exact: true }),
    ).not.toContainText("Current conversation");
    await expect(
      page
        .getByRole("dialog", { name: "Jev", exact: true })
        .getByRole("switch"),
    ).toHaveCount(0);
    expect(await readFile(join(root, "app", "jev.json"), "utf8")).toBe(
      credentials,
    );
    await app!.close();
    page = await launch();
    const saved = await page.evaluate(() =>
      window.worklens.invoke("bootstrap", undefined),
    );
    expect(saved.jev?.configured).toBe(true);
    expect(saved.tools).toContain("jev_classify");
    const reopened = await page.evaluate(
      (id) => window.worklens.invoke("open", { id }),
      started.id,
    );
    expect(reopened.jevConsent?.blocked).toBe(true);
    expect(evaluations()).toHaveLength(3);
    expect(await readFile(join(root, "app", "jev.json"), "utf8")).toBe(
      credentials,
    );
  } finally {
    await app?.close();
    await modelServer.close();
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});
