import { expect, test, _electron as electron } from "@playwright/test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

for (const packaged of [false, true]) {
  test(`conversation search ${packaged ? "packaged ASAR" : "Electron"}: long-text worker and formula reveal`, async () => {
    test.skip(
      packaged && !process.env.WORKLENS_PACKAGED_EXE,
      "Run with an unpacked or installed application",
    );
    const root = await mkdtemp(join(tmpdir(), "worklens-search-desktop-"));
    const create = (title: string, text: string) => {
      const manager = SessionManager.create(root, join(root, "sessions"));
      manager.appendMessage({
        role: "user",
        content: "Explain this example",
        timestamp: Date.now(),
      });
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text }],
        api: "openai-completions",
        provider: "worklens-test",
        model: "fixture",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      });
      manager.appendSessionInfo(title);
      return manager.getSessionId();
    };
    const longId = create(
      "Long worker example",
      "A **review** paragraph with [link](https://example.com) and `code`.\n\n".repeat(
        3000,
      ) + "workerneedle",
    );
    create(
      "Math example",
      String.raw`Cost $12 and $24. www.example.com（**今天** 很好） Formula $x^2$ and \(\frac{a}{b}\).`,
    );
    const env: NodeJS.ProcessEnv = { ...process.env, WORKLENS_TEST_ROOT: root };
    delete env.ELECTRON_RUN_AS_NODE;
    for (const key of Object.keys(env))
      if (
        /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|GITHUB_TOKEN|GH_TOKEN)$/.test(key)
      )
        delete env[key];
    const app = await electron.launch({
      cwd: resolve("."),
      args: packaged ? [] : ["."],
      env: env as Record<string, string>,
      ...(packaged
        ? { executablePath: resolve(process.env.WORKLENS_PACKAGED_EXE!) }
        : {}),
    });
    try {
      const page = await app.firstWindow();
      await expect(page.locator(".sidebar")).toBeVisible();
      const heartbeat = await app.evaluate(async ({ app }) => {
        const vm = process.getBuiltinModule("node:vm");
        const uri = process
          .getBuiltinModule("node:url")
          .pathToFileURL(app.getAppPath() + "/dist/main/index.js").href;
        const main = await vm.runInThisContext(
          `import(${JSON.stringify(uri)})`,
          {
            importModuleDynamically:
              vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
          },
        );
        let ticks = 0;
        const timer = setInterval(() => ticks++, 5);
        try {
          return { results: await main.agents.search("workerneedle"), ticks };
        } finally {
          clearInterval(timer);
        }
      });
      expect(heartbeat.results).toMatchObject([
        { id: longId, snippet: { match: "workerneedle" } },
      ]);
      expect(heartbeat.ticks).toBeGreaterThan(5);
      for (const query of [
        "$12",
        "今天 很好",
        "x^2",
        String.raw`\frac{a}{b}`,
      ]) {
        await page.keyboard.press("ControlOrMeta+k");
        const dialog = page.getByRole("dialog", {
          name: "Search conversations",
        });
        await dialog.getByRole("combobox").fill(query);
        await expect(dialog.getByRole("option")).toHaveCount(1);
        await page.keyboard.press("Enter");
        await expect(dialog).toBeHidden();
        if (query === "x^2" || query.startsWith("\\frac")) {
          const formula = page.locator(".katex[data-search-match]");
          await expect(formula).toHaveCount(1);
          await expect(
            formula.locator('annotation[encoding="application/x-tex"]'),
          ).toHaveText(query);
        } else {
          await expect
            .poll(() =>
              page.evaluate(() => {
                const highlight = CSS.highlights.get("worklens-search");
                return highlight ? [...highlight][0].toString() : undefined;
              }),
            )
            .toBe(query);
        }
      }
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
