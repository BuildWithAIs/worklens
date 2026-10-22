import { expect, type ElectronApplication, type Page } from "@playwright/test";
import type { ApprovalService } from "../../src/main/permissions/approval-service";
import type { OperationInput } from "../../src/main/permissions/types";
import type { Requests } from "../../src/shared/contracts";

function invokeFromRenderer<M extends keyof Requests>(
  app: ElectronApplication,
  method: M,
  input: Requests[M]["input"],
): Promise<Requests[M]["output"]> {
  // Playwright keeps a crashed Page marked unusable after Electron reloads it.
  // Execute in the replacement renderer; the real preload and IPC checks apply.
  return app.evaluate(
    ({ BrowserWindow }, { method, input }) =>
      BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
        `window.worklens.invoke(${JSON.stringify(method)}, ${JSON.stringify(input)})`,
      ),
    { method, input },
  );
}

/** Real window lifecycle and IPC, with a main-only, non-networking test adapter. */
export async function verifyPermissionDisconnect(
  app: ElectronApplication,
  page: Page,
  mode: "reload" | "crash",
  crashDirectory: string,
) {
  const task = await page.evaluate(async () => {
    const view = await window.worklens.invoke("send", {
      requestId: crypto.randomUUID(),
      text: "SLOW " + "invented lifecycle task ".repeat(60),
      selection: {
        provider: "worklens-test",
        model: "worklens-test",
        thinking: "off",
      },
    });
    return { id: view.id, runId: view.runId! };
  });
  // Inspect the actual service through Playwright's main-process debugger. No
  // renderer-facing test hook or ability to mint approval identities is added.
  const probe = await app.evaluateHandle(
    async ({ app, BrowserWindow }, { task, mode }) => {
      const vm = process.getBuiltinModule("node:vm");
      const uri = process
        .getBuiltinModule("node:url")
        .pathToFileURL(app.getAppPath() + "/dist/main/index.js").href;
      const imported = await vm.runInThisContext(
        `import(${JSON.stringify(uri)})`,
        {
          importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
        },
      );
      const service = imported.agents.permissions as ApprovalService;
      const context = service.contexts.create(
        task.id,
        task.runId,
        "lifecycle-probe",
        "internal",
      );
      const input = (host: string): OperationInput => ({
        tool: "controlled-http",
        summary: "Synthetic lifecycle check",
        review: { receiver: host, port: 443 },
        payload: { content: "invented lifecycle payload" },
        effects: [{ kind: "network.connect", host, port: 443 }],
        expectedTargets: { destination: host },
        executionTarget: "trusted-main",
      });
      const seed = service.prepare(context, input("example.test"));
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let signal: AbortSignal | undefined;
      let waiter = "waiting";
      let execution: Promise<string> | undefined;
      let offline:
        | { ownerOnline: boolean; automatic: boolean; error?: string }
        | undefined;
      const observeDisconnect = () => {
        try {
          const plan = service.prepare(context, input("example.test"));
          offline = {
            ownerOnline: !!(service as unknown as { owner?: object }).owner,
            automatic: !service
              .snapshot(task.id)
              .pending.some((p) => p.id === plan.id),
          };
        } catch (error) {
          offline = {
            ownerOnline: false,
            automatic: false,
            error: String(error),
          };
        }
      };
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      const onNavigation = (
        details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
      ) => {
        if (details.isMainFrame && !details.isSameDocument) observeDisconnect();
      };
      return {
        seedId: seed.id,
        start() {
          const pending = service.prepare(context, input("other.test"));
          void service.waitForApproval(pending).then(
            () => {
              waiter = "approved";
            },
            (error) => {
              waiter = String(error);
            },
          );
          const running = service.prepare(context, input("example.test"));
          execution = service
            .execute(
              running,
              async (p) => ({
                payloadHash: p.payloadHash,
                expectedTargets: p.expectedTargets,
                executionTarget: p.executionTarget,
              }),
              async (_payload, adapterSignal) => {
                signal = adapterSignal;
                await gate;
                // This probe performs no side effect and makes no completion claim.
                throw new Error(
                  "Synthetic adapter stopped after lifecycle check",
                );
              },
            )
            .then(
              () => "unexpected completion",
              (error) => String(error),
            );
          if (mode === "reload")
            contents.once("did-start-navigation", onNavigation);
          else contents.once("render-process-gone", observeDisconnect);
          return pending.id;
        },
        status() {
          return {
            started: !!signal,
            aborted: signal?.aborted,
            waiter,
            offline,
            snapshot: service.snapshot(task.id),
          };
        },
        async cleanup() {
          contents.removeListener("did-start-navigation", onNavigation);
          contents.removeListener("render-process-gone", observeDisconnect);
          release();
          return await execution;
        },
      };
    },
    { task, mode },
  );
  try {
    const seedId = await probe.evaluate((p) => p.seedId);
    await page.evaluate(
      async ({ id, requestId }) =>
        window.worklens.invoke("permissionReply", {
          conversationId: id,
          requestId,
          decision: "allow",
          scope: "task",
        }),
      { id: task.id, requestId: seedId },
    );
    const pendingId = await probe.evaluate((p) => p.start());
    await expect
      .poll(() => probe.evaluate((p) => p.status().started))
      .toBe(true);
    const before = await probe.evaluate((p) => p.status().snapshot);
    expect(before.pending.map((p) => p.id)).toEqual([pendingId]);
    if (mode === "reload") {
      await page.reload();
    } else {
      const reason = await app.evaluate(
        async ({ app, BrowserWindow, crashReporter }, directory) => {
          app.setPath("crashDumps", directory);
          crashReporter.start({
            uploadToServer: false,
            ignoreSystemCrashHandler: true,
          });
          const contents = BrowserWindow.getAllWindows()[0].webContents;
          const gone = new Promise<string>((resolve) => {
            contents.once("render-process-gone", (_event, details) =>
              resolve(details.reason),
            );
          });
          // Page.crash exercises an actual renderer crash. Electron's
          // forcefullyCrashRenderer() may only report a process kill on macOS.
          contents.debugger.attach();
          void contents.debugger.sendCommand("Page.crash").catch(() => {});
          const reason = await gone;
          if (contents.debugger.isAttached()) contents.debugger.detach();
          return reason;
        },
        crashDirectory,
      );
      expect(reason).toBe("crashed");
      // Recover through the main process: the crashed page cannot invoke IPC.
      const loaded = page.waitForEvent("domcontentloaded");
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].webContents.reload(),
      );
      await loaded;
    }
    if (mode === "reload") await expect(page.locator(".sidebar")).toBeVisible();
    else
      await expect
        .poll(() =>
          app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
              '!!document.querySelector(".sidebar")?.getClientRects().length',
            ),
          ),
        )
        .toBe(true);
    const liveTask = await invokeFromRenderer(app, "open", { id: task.id });
    expect(liveTask.phase).toBe("generating");
    expect(liveTask.runId).toBe(task.runId);
    const status = await probe.evaluate((p) => p.status());
    expect(status).toMatchObject({
      started: true,
      aborted: false,
      waiter: "waiting",
      offline: {
        ownerOnline: false,
        automatic: true,
      },
    });
    expect(status.offline?.error).toBeUndefined();
    expect(status.snapshot.runId).toBe(task.runId);
    expect(status.snapshot.revision).toBe(before.revision);
    expect(status.snapshot.pending.map((p) => p.id)).toEqual([pendingId]);
    // The replacement document answers the exact request created by the old one.
    await invokeFromRenderer(app, "permissionReply", {
      conversationId: task.id,
      requestId: pendingId,
      decision: "allow",
      scope: "once",
    });
    await expect
      .poll(() => probe.evaluate((p) => p.status().waiter))
      .toBe("approved");
    expect(await probe.evaluate((p) => p.cleanup())).toContain(
      "SIDE_EFFECT_UNKNOWN",
    );
    await invokeFromRenderer(app, "cancel", {
      conversationId: task.id,
      runId: task.runId,
    });
    const ended = await invokeFromRenderer(app, "permissionsGet", {
      conversationId: task.id,
    });
    expect(ended.runId).toBeUndefined();
    expect(ended.pending).toEqual([]);
    expect(ended.grants).toEqual([]);
  } finally {
    await probe.evaluate((p) => p.cleanup());
    await probe.dispose();
  }
}
