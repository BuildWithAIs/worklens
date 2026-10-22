import { test, expect, _electron as electron } from "@playwright/test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { PermissionEvent } from "../../src/shared/permissions";
import { mockServer, fixtureModel } from "../mock-server";
import { verifyPermissionDisconnect } from "./permission-lifecycle";

test("permission IPC preserves main-window identity, task provenance and event unsubscription", async () => {
  const root = await mkdtemp(join(tmpdir(), "worklens-permission-e2e-"));
  const crashDirectory = join(root, "crashes");
  await mkdir(crashDirectory);
  const server = await mockServer({ delayMs: 100 });
  const env: NodeJS.ProcessEnv = { ...process.env, WORKLENS_TEST_ROOT: root };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env))
    if (/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|GITHUB_TOKEN|GH_TOKEN)$/.test(key))
      delete env[key];
  const app = await electron.launch({
    executablePath: process.env.WORKLENS_PACKAGED_EXE,
    args: process.env.WORKLENS_PACKAGED_EXE ? [] : ["."],
    cwd: resolve("."),
    env: env as Record<string, string>,
  });
  try {
    let page = await app.firstWindow();
    await expect(page.locator(".sidebar")).toBeVisible();
    await app.evaluate(
      async ({ app }, { url, model }) => {
        const vm = process.getBuiltinModule("node:vm");
        const uri = process
          .getBuiltinModule("node:url")
          .pathToFileURL(app.getAppPath() + "/dist/main/index.js").href;
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
          apiKey: "synthetic-placeholder",
          models: [model],
        });
        await imported.agents.modelRuntime.refresh({ allowNetwork: false });
      },
      { url: server.url, model: fixtureModel },
    );
    const result = await page.evaluate(async () => {
      const events: PermissionEvent[] = [];
      const unsubscribe = window.worklens.onPermission((event) =>
        events.push(event),
      );
      const selection = {
        provider: "worklens-test",
        model: "worklens-test",
        thinking: "off" as const,
      };
      const view = await window.worklens.invoke("send", {
        requestId: crypto.randomUUID(),
        text: "SLOW invented permission IPC task",
        selection,
      });
      const active = await window.worklens.invoke("permissionsGet", {
        conversationId: view.id,
      });
      await window.worklens.invoke("cancel", {
        conversationId: view.id,
        runId: view.runId!,
      });
      const ended = await window.worklens.invoke("permissionsGet", {
        conversationId: view.id,
      });
      unsubscribe();
      const count = events.length;
      const again = await window.worklens.invoke("send", {
        conversationId: view.id,
        requestId: crypto.randomUUID(),
        text: "SLOW invented follow-up task",
        selection,
      });
      await window.worklens.invoke("cancel", {
        conversationId: view.id,
        runId: again.runId!,
      });
      let pickerError = "";
      try {
        await window.worklens.invoke("permissionSelectFiles", {
          conversationId: view.id,
          intent: "read",
        });
      } catch (error) {
        pickerError = (error as Error).message;
      }
      let forgedError = "";
      try {
        await window.worklens.invoke("permissionReply", {
          conversationId: view.id,
          requestId: crypto.randomUUID(),
          decision: "allow",
          scope: "once",
          payload: "replacement",
        } as never);
      } catch (error) {
        forgedError = (error as Error).message;
      }
      return {
        conversationId: view.id,
        runId: view.runId,
        active,
        ended,
        count,
        finalCount: events.length,
        events,
        pickerError,
        forgedError,
      };
    });
    expect(result.active).toMatchObject({
      conversationId: result.conversationId,
      runId: result.runId,
      enforcement: "not-connected",
      backends: { vm: false, hostSrt: false, fileBoundary: false },
    });
    expect(result.ended.runId).toBeUndefined();
    expect(result.ended.grants).toEqual([]);
    expect(result.events.length).toBeGreaterThan(0);
    expect(
      result.events.every(
        (event) =>
          event.conversationId === result.conversationId &&
          event.runId === result.runId,
      ),
    ).toBe(true);
    expect(result.finalCount).toBe(result.count);
    expect(result.pickerError).toContain("CAPABILITY_UNSUPPORTED");
    expect(result.forgedError).toContain("payload");
    await verifyPermissionDisconnect(app, page, "reload", crashDirectory);
    const otherWindowError = await app.evaluate(
      async ({ app, BrowserWindow }) => {
        const other = new BrowserWindow({
          show: false,
          webPreferences: {
            preload: app.getAppPath() + "/dist/preload/index.cjs",
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
          },
        });
        try {
          await other.loadURL("about:blank");
          return await other.webContents.executeJavaScript(
            'window.worklens.invoke("permissionsGet", { conversationId: "synthetic-other-window" }).then(() => "unexpected approval", error => error.message)',
          );
        } finally {
          other.destroy();
        }
      },
    );
    expect(otherWindowError).toContain("不受信任的调用来源");
    if (process.platform === "darwin") {
      const closingTask = await page.evaluate(async () => {
        const view = await window.worklens.invoke("send", {
          requestId: crypto.randomUUID(),
          text: "SLOW " + "invented close task ".repeat(40),
          selection: {
            provider: "worklens-test",
            model: "worklens-test",
            thinking: "off",
          },
        });
        return {
          id: view.id,
          runId: view.runId!,
        };
      });
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].close(),
      );
      await expect
        .poll(() =>
          app.evaluate(
            ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
          ),
        )
        .toBe(0);
      const reopened = app.waitForEvent("window");
      await app.evaluate(({ app }) => {
        app.emit("activate");
      });
      const replacement = await reopened;
      await expect(replacement.locator(".sidebar")).toBeVisible();
      const state = await replacement.evaluate(
        async ({ id }) => ({
          view: await window.worklens.invoke("open", { id }),
          permission: await window.worklens.invoke("permissionsGet", {
            conversationId: id,
          }),
        }),
        { id: closingTask.id },
      );
      // Closing is an explicit product cancellation, unlike renderer disconnect.
      expect(state.view.phase).toBe("cancelled");
      expect(state.permission.runId).toBeUndefined();
      expect(state.permission.grants).toEqual([]);
      expect(state.permission.pending).toEqual([]);
      page = replacement;
    }
    await verifyPermissionDisconnect(app, page, "crash", crashDirectory);
  } finally {
    await app.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
