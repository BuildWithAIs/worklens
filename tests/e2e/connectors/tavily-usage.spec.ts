import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
} from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("saved Tavily credentials expose read-only account credits through Electron IPC", async () => {
  const root = await mkdtemp(join(tmpdir(), "worklens-tavily-usage-desktop-"));
  const requests: string[] = [];
  let used = 56;
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const authorized =
      req.headers.authorization === "Bearer synthetic-tavily-usage-key";
    res.writeHead(authorized ? 200 : 401, {
      "content-type": "application/json",
    });
    res.end(
      JSON.stringify(
        authorized
          ? {
              key: { usage: 1, limit: 10 },
              account: {
                current_plan: "Free",
                plan_usage: used,
                plan_limit: 1000,
                paygo_usage: 20,
                paygo_limit: 100,
              },
            }
          : { detail: "Unauthorized" },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const env: NodeJS.ProcessEnv = { ...process.env, WORKLENS_TEST_ROOT: root };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env))
    if (/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|GITHUB_TOKEN|GH_TOKEN)$/.test(key))
      delete env[key];
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({
      args: ["."],
      cwd: resolve("."),
      env: env as Record<string, string>,
    });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Connectors", exact: true }).click();
    await page
      .getByRole("button", { name: "Connect Tavily", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Tavily", exact: true });
    await dialog.locator("#tavily-url").fill(url);
    await dialog.locator("#tavily-token").fill("synthetic-tavily-usage-key");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await page
      .getByRole("button", { name: "Manage Tavily", exact: true })
      .click();
    await expect(
      dialog.getByText("56 / 1,000 Credits", { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByText("20 / 100 Credits", { exact: true }),
    ).toBeVisible();
    await expect(dialog.getByRole("meter")).toHaveCount(2);
    const snapshot = await page.evaluate(() =>
      window.worklens.invoke("bootstrap", undefined),
    );
    expect(JSON.stringify(snapshot)).not.toContain(
      "synthetic-tavily-usage-key",
    );
    expect(snapshot.tavily?.configured).toBe(true);
    expect(
      await readFile(join(root, "app", "tavily.json"), "utf8"),
    ).not.toContain("synthetic-tavily-usage-key");
    for (let i = 0; i < 12; i++) {
      // Draft edits remount the usage section; opening the dialog remounts it too.
      await dialog.locator("#tavily-token").fill("draft-key");
      await dialog.locator("#tavily-token").fill("");
      await expect(
        dialog.getByText("56 / 1,000 Credits", { exact: true }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).not.toBeVisible();
      await page
        .getByRole("button", { name: "Manage Tavily", exact: true })
        .click();
      await expect(
        dialog.getByText("56 / 1,000 Credits", { exact: true }),
      ).toBeVisible();
    }
    expect(requests).toEqual(["GET /usage"]);
    used = 62;
    await dialog
      .getByRole("button", { name: "Test connection", exact: true })
      .click();
    await expect(
      dialog.getByText("62 / 1,000 Credits", { exact: true }),
    ).toBeVisible();
    expect(requests).toEqual(["GET /usage", "GET /usage"]);
    await dialog
      .getByRole("button", { name: "Disconnect", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "Disconnect Tavily?", exact: true })
      .getByRole("button", { name: "Disconnect", exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
    used = 68;
    await page
      .getByRole("button", { name: "Connect Tavily", exact: true })
      .click();
    await dialog.locator("#tavily-url").fill(url);
    await dialog.locator("#tavily-token").fill("synthetic-tavily-usage-key");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await page
      .getByRole("button", { name: "Manage Tavily", exact: true })
      .click();
    await expect(
      dialog.getByText("68 / 1,000 Credits", { exact: true }),
    ).toBeVisible();
    expect(requests).toEqual(["GET /usage", "GET /usage", "GET /usage"]);
  } finally {
    await app?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
