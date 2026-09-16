import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  app,
  BrowserWindow,
  ipcMain,
  safeStorage,
  shell,
  dialog,
  nativeTheme,
  Menu,
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
import { createConnectors } from "./connectors";
import { isConnectorRequest } from "./connectors/ipc";
import { LocalArtifacts } from "./local-artifacts";
import { SkillsService } from "./skills";

// Keep the original safeStorage identity: changing case selects a different
// macOS Keychain key. The application bundle controls the Dock display name.
app.setName("worklens");

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
  skills: join(root, "skills"),
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
      const applicationIcon = app.isPackaged
        ? join(process.resourcesPath, "icon.png")
        : join(app.getAppPath(), "build/icon.png");
      if (process.platform === "darwin") app.dock?.setIcon(applicationIcon);
      const credentials = new SecureCredentials(
        join(paths.userData, "credentials"),
        safeStorage,
      );
      const state = new StateStore(join(paths.userData, "app-state.json"));
      await state.load();
      const bundledSkills = app.isPackaged
        ? join(process.resourcesPath, "skills")
        : join(app.getAppPath(), "resources/skills");
      const skills = new SkillsService(
        paths.skills,
        join(homedir(), ".agents", "skills"),
        bundledSkills,
        state,
      );
      await skills.initialize();
      const artifacts = new LocalArtifacts(
        join(root, "artifacts"),
        paths.runtime,
      );
      const connectors = createConnectors(
        paths.userData,
        safeStorage,
        artifacts,
      );
      await connectors.registry.initialize();
      const redact = (text: string) =>
        credentials.redact(connectors.registry.redact(text));
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
        redact,
        connectors.registry,
        skills,
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
            if (isConnectorRequest(method)) {
              value = await connectors.requests(method, input);
            } else
              switch (method) {
                case "artifact": {
                  const artifact = await artifacts.get(input.id);
                  if (input.action === "show")
                    shell.showItemInFolder(artifact.path);
                  else if (input.action === "open") {
                    const error = await shell.openPath(artifact.path);
                    if (error) throw new Error(error);
                  } else {
                    const chosen = await dialog.showSaveDialog(window!, {
                      defaultPath: artifact.path,
                      properties: [
                        "showOverwriteConfirmation",
                        "createDirectory",
                      ],
                    });
                    if (!chosen.canceled && chosen.filePath)
                      await artifacts.copy(artifact.id, chosen.filePath);
                  }
                  break;
                }
                case "bootstrap":
                  value = {
                    settings: state.value,
                    ...connectors.bootstrap(),
                    providers: await providers!.list(),
                    conversations: await agents!.list(),
                    globalUsage: agents!.getGlobalUsage(),
                    paths,
                    version: app.getVersion(),
                    tools: [...toolNames, ...connectors.registry.names()],
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
                case "htmlFileAction": {
                  const file = await agents!.htmlActionFile(input.id, {
                    path: input.path,
                    code: input.code,
                  });
                  if (input.action === "reveal") shell.showItemInFolder(file);
                  else {
                    if (process.platform !== "darwin")
                      throw new Error(
                        "Chrome opening is currently supported on macOS only",
                      );
                    await promisify(execFile)("/usr/bin/open", [
                      "-a",
                      "Google Chrome",
                      file,
                    ]);
                  }
                  break;
                }
                case "previewHtml":
                  value = await agents!.previewHtml(input.id, input.path);
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
                  await shell.openPath(
                    paths[input.which as keyof typeof paths],
                  );
                  break;
                case "dismissRecovery":
                  await agents!.dismissRecovery(input.runId);
                  break;
                case "refreshModels":
                  value = await providers!.refreshModels(input.provider);
                  break;
                case "skillsList":
                  value = skills.list();
                  break;
                case "skillsRefresh":
                  value = skills.refresh();
                  break;
                case "skillsToggle":
                  value = await skills.setEnabled(input.name, input.enabled);
                  break;
                case "skillsReveal":
                  shell.showItemInFolder(skills.pathOf(input.name));
                  break;
              }
            return {
              ok: true,
              value: redactStrings(value, redact),
            };
          } catch (error) {
            return {
              ok: false,
              error: redact(
                error instanceof Error ? error.message : "操作失败",
              ).slice(0, 1600),
            };
          }
        },
      );
      const createWindow = () => {
        nativeTheme.themeSource = state.value.theme;
        window = new BrowserWindow({
          width: 1260,
          height: 860,
          minWidth: 850,
          minHeight: 620,
          title: "WorkLens",
          icon: applicationIcon,
          backgroundColor:
            process.platform === "darwin" ? "#00000000" : "#ffffff",
          ...(process.platform === "darwin"
            ? {
                titleBarStyle: "hidden" as const,
                trafficLightPosition: { x: 20, y: 20 },
                vibrancy: "popover" as const,
                visualEffectState: "followWindow" as const,
              }
            : {}),
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
        // Keep web UI geometry aligned with the unscaled native window controls.
        const contents = window.webContents;
        contents.on("dom-ready", () => contents.setZoomFactor(1));
        contents.on("zoom-changed", () => contents.setZoomFactor(1));
        contents.on("before-input-event", (event, input) => {
          const modifier =
            process.platform === "darwin" ? input.meta : input.control;
          if (
            modifier &&
            !input.alt &&
            ["+", "=", "-", "0"].includes(input.key)
          ) {
            event.preventDefault();
          }
        });
        const hidePageZoom = (menu: Menu) => {
          for (const item of menu.items) {
            if (["resetzoom", "zoomin", "zoomout"].includes(item.role ?? "")) {
              item.visible = false;
              item.enabled = false;
            }
            if (item.submenu) hidePageZoom(item.submenu);
          }
          // Hidden zoom entries must not leave consecutive menu dividers.
          let divider = true;
          for (const item of menu.items) {
            if (!item.visible) continue;
            if (item.type === "separator") {
              item.visible = !divider;
              divider = true;
            } else divider = false;
          }
        };
        const menu = Menu.getApplicationMenu();
        if (menu) {
          hidePageZoom(menu);
          Menu.setApplicationMenu(menu);
        }
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
          // before-quit already awaits AgentService.shutdown. Deferring this
          // close a second time cancels app.quit on macOS and leaves it running.
          if (readyToClose || quitting) return;
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
