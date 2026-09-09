import {
  app,
  BrowserWindow,
  ipcMain,
  safeStorage,
  shell,
  dialog,
  nativeTheme,
} from "electron";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  SecureCredentials,
  StateStore,
  ModelCache,
  redactStrings,
} from "./storage";
import { AgentService } from "./agent-service";
import { ProviderService } from "./providers";
import { schemas, externalUrl } from "./validation";
import { toolNames } from "./resources";
import type { Requests } from "../shared/contracts";

const directory = fileURLToPath(new URL(".", import.meta.url));
const testRoot = process.env.WORKLENS_TEST_ROOT;
if (testRoot) app.setPath("userData", join(resolve(testRoot), "app"));
else if (!app.isPackaged)
  app.setPath("userData", join(app.getPath("appData"), "WorkLens-dev"));
const root = testRoot
  ? resolve(testRoot)
  : join(homedir(), app.isPackaged ? ".worklens" : ".worklens-dev");
const paths = {
  root,
  runtime: join(root, "runtime"),
  sessions: join(root, "sessions"),
  userData: app.getPath("userData"),
};
let window: BrowserWindow | undefined;
export let agents: AgentService | undefined;
let providers: ProviderService | undefined;
let quitting = false;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (window?.isMinimized()) window.restore();
    window?.show();
    window?.focus();
  });
  void app
    .whenReady()
    .then(async () => {
      app.setAppUserModelId("com.buildwithais.worklens");
      const credentials = new SecureCredentials(
        join(paths.userData, "credentials"),
        safeStorage,
      );
      const state = new StateStore(join(paths.userData, "app-state.json"));
      await state.load();
      const runtime = await ModelRuntime.create({
        credentials,
        modelsPath: null,
        modelsStore: new ModelCache(join(paths.userData, "model-cache")),
        allowModelNetwork: false,
        modelRefreshTimeoutMs: 15000,
      });
      const broadcast = (channel: string, event: unknown) => {
        if (window && !window.isDestroyed())
          window.webContents.send(channel, event);
      };
      agents = new AgentService(
        runtime,
        paths,
        (event) => broadcast("worklens:chat", event),
        (text) => credentials.redact(text),
      );
      await agents.initialize();
      providers = new ProviderService(runtime, credentials, (event) =>
        broadcast("worklens:auth", event),
      );
      ipcMain.handle(
        "worklens:request",
        async (event, method: keyof Requests, raw: unknown) => {
          try {
            if (
              !window ||
              event.sender !== window.webContents ||
              event.senderFrame !== window.webContents.mainFrame
            )
              throw new Error("不受信任的调用来源");
            if (!Object.hasOwn(schemas, method)) throw new Error("未知请求");
            const input = schemas[method].parse(raw) as any;
            let value: unknown;
            switch (method) {
              case "bootstrap":
                value = {
                  settings: state.value,
                  providers: await providers!.list(),
                  conversations: await agents!.list(),
                  paths,
                  version: app.getVersion(),
                  tools: toolNames,
                  diagnostics: agents!.diagnostics,
                  recoveries: agents!.recoveries,
                };
                break;
              case "settings":
                value = await state.update(input);
                nativeTheme.themeSource = state.value.theme;
                break;
              case "providers":
                value = await providers!.list();
                break;
              case "login":
                await providers!.login(
                  input.provider,
                  input.type,
                  input.loginId,
                );
                break;
              case "authReply":
                providers!.reply(input.loginId, input.promptId, input.value);
                break;
              case "authCancel":
                providers!.cancel(input.loginId);
                break;
              case "logout":
                await runtime.logout(input.provider, {
                  signal: AbortSignal.timeout(15000),
                });
                providers!.clearConnection(input.provider);
                break;
              case "azure":
                await providers!.azure(input);
                break;
              case "test":
                value = await providers!.test(input);
                break;
              case "clearConnection":
                providers!.clearConnection(input.provider);
                break;
              case "open":
                value = await agents!.open(input.id);
                await state.update({ lastConversation: input.id });
                break;
              case "rename":
                await agents!.rename(input.id, input.title);
                break;
              case "delete":
                await agents!.delete(input.id);
                break;
              case "send":
                value = await agents!.send(input);
                break;
              case "cancel":
                await agents!.cancel(input.conversationId, input.runId);
                break;
              case "model":
                value = await agents!.setModel(input.id, input.selection);
                break;
              case "external":
                await shell.openExternal(externalUrl(input.url));
                break;
              case "showPath":
                await shell.openPath(paths[input.which as keyof typeof paths]);
                break;
              case "dismissRecovery":
                await agents!.dismissRecovery(input.runId);
                break;
              case "refreshModels":
                value = await providers!.refreshModels(input.provider);
                break;
            }
            return {
              ok: true,
              value: redactStrings(value, (text) => credentials.redact(text)),
            };
          } catch (error) {
            return {
              ok: false,
              error: credentials
                .redact(error instanceof Error ? error.message : "操作失败")
                .slice(0, 1600),
            };
          }
        },
      );
      const createWindow = () => {
        window = new BrowserWindow({
          width: 1260,
          height: 860,
          minWidth: 850,
          minHeight: 620,
          title: "WorkLens",
          backgroundColor: "#f6f4ef",
          show: false,
          autoHideMenuBar: true,
          webPreferences: {
            preload: join(directory, "../preload/index.cjs"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
          },
        });
        nativeTheme.themeSource = state.value.theme;
        window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        window.webContents.on("will-navigate", (event) =>
          event.preventDefault(),
        );
        window.webContents.session.setPermissionRequestHandler(
          (_contents, _permission, callback) => callback(false),
        );
        window.once("ready-to-show", () => window?.show());
        const ownedWindow = window;
        let closing = false;
        let readyToClose = false;
        ownedWindow.on("closed", () => {
          if (window === ownedWindow) window = undefined;
        });
        ownedWindow.on("close", (event) => {
          if (readyToClose) return;
          event.preventDefault();
          if (closing) return;
          closing = true;
          providers?.shutdown();
          void (agents?.cancelAll() ?? Promise.resolve()).finally(() => {
            readyToClose = true;
            ownedWindow.close();
          });
        });
        if (process.env.ELECTRON_RENDERER_URL && !app.isPackaged)
          void window.loadURL(process.env.ELECTRON_RENDERER_URL);
        else void window.loadFile(join(directory, "../renderer/index.html"));
      };
      createWindow();
      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
      });
    })
    .catch((error) => {
      dialog.showErrorBox(
        "WorkLens 无法启动",
        error instanceof Error ? error.message : "初始化失败",
      );
      app.quit();
    });
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    providers?.shutdown();
    void (agents?.shutdown() ?? Promise.resolve()).finally(() => app.quit());
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
