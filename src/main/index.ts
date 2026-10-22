import { assertRequestSource } from "./ipc-source";
import { ApprovalService } from "./permissions/approval-service";
import { PermissionStore } from "./permissions/store";
import { AuditService } from "./permissions/audit-service";
import {
  app,
  BrowserWindow,
  ipcMain,
  safeStorage,
  shell,
  dialog,
  nativeTheme,
  Menu,
  session,
} from "electron";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
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
import { binaryRequests, requestHandlers } from "./ipc";
import type { ChatEvent, Requests } from "../shared/contracts";
import { ChatUpdates } from "./chat-updates";
import { createConnectors } from "./connectors";
import { isConnectorRequest } from "./connectors/ipc";
import { LocalArtifacts } from "./local-artifacts";
import { SkillsService } from "./skills";
import { McpService } from "./mcp-service";
import { installationId } from "./installation-id";
import { NetworkProxy, readShellProxy } from "./network-proxy";
import { trustSystemCertificates } from "./system-certificates";

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
// Exported for Electron acceptance tests, which register local model fixtures.
export let agents: AgentService | undefined;
let providers: ProviderService | undefined;
let mcp: McpService | undefined;
let quitting = false;
let permissions: ApprovalService | undefined;
let permissionReviewer: object | undefined;
const chatUpdates = new ChatUpdates();
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
      // Before any connector, MCP server or model request opens a TLS connection.
      trustSystemCertificates();
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
      // Apply the proxy before any service validates connections or calls models.
      // The probe session keeps "system" mode so detection always sees the
      // operating system's settings, whatever WorkLens is configured to use.
      const proxyProbe = session.fromPartition("worklens-proxy-probe");
      await proxyProbe.setProxy({ mode: "system" });
      const proxy = new NetworkProxy({
        resolveSystem: (url) => proxyProbe.resolveProxy(url),
        setSessionProxy: (config) => session.defaultSession.setProxy(config),
        readShellProxy,
      });
      await proxy.apply(state.value.proxy);
      const mcpService = new McpService(
        join(paths.userData, "pi"),
        safeStorage,
        (event) => {
          if (window && !window.isDestroyed())
            window.webContents.send("worklens:auth", event);
        },
        (url) => shell.openExternal(externalUrl(url)),
      );
      mcp = mcpService;
      mcpService.initialize();
      const bundledSkills = app.isPackaged
        ? join(process.resourcesPath, "skills")
        : join(app.getAppPath(), "resources/skills");
      const skills = new SkillsService(
        paths.skills,
        testRoot
          ? join(root, "local-skills")
          : join(homedir(), ".agents", "skills"),
        bundledSkills,
        state,
      );
      await skills.initialize();
      const artifacts = new LocalArtifacts(
        join(root, "artifacts"),
        paths.sessions,
      );
      const connectors = createConnectors(
        paths.userData,
        safeStorage,
        artifacts,
        {
          redact: (text) => credentials.redact(text),
          onConsentChange: (id) => agents?.connectorConsentChanged(id),
        },
      );
      await connectors.registry.initialize();
      const redact = (text: string) =>
        credentials.redact(connectors.registry.redact(mcpService.redact(text)));
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
      const sendChat = (event: ChatEvent) => {
        if (window && !window.isDestroyed())
          window.webContents.send("worklens:chat", chatUpdates.encode(event));
      };
      const permissionService = new ApprovalService(
        new PermissionStore(
          join(paths.userData, "permissions", "rules.json"),
          safeStorage,
        ),
        new AuditService(
          join(paths.userData, "permissions", "audit.json"),
          safeStorage,
        ),
        { redact, emit: (event) => broadcast("worklens:permission", event) },
      );
      await permissionService.initialize();
      permissions = permissionService;
      const agentService = new AgentService(
        runtime,
        paths,
        sendChat,
        redact,
        connectors.registry,
        skills,
        artifacts,
        connectors.jevConsent,
        mcpService,
        () => state.value.codemodeEnabled !== false,
        permissionService,
      );
      agents = agentService;
      await agentService.initialize();
      if (state.recoveredFrom)
        agentService.diagnostics.push(
          `应用设置文件无法读取，已改用默认设置。原文件已保留在 ${state.recoveredFrom}。`,
        );
      const providerService = new ProviderService(
        runtime,
        credentials,
        (event) => broadcast("worklens:auth", event),
        installationId(join(paths.userData, "installation-id")),
      );
      providers = providerService;
      const handlers = requestHandlers({
        paths,
        version: app.getVersion(),
        window: () => window,
        redact,
        state,
        proxy,
        mcp: mcpService,
        agents: agentService,
        providers: providerService,
        skills,
        artifacts,
        connectors,
        runtime,
        permissions: permissionService,
        permissionReviewer: () => permissionReviewer,
      });
      ipcMain.handle(
        "worklens:request",
        async (event, method: keyof Requests, raw: unknown) => {
          try {
            assertRequestSource(window, event);
            if (!Object.hasOwn(schemas, method)) throw new Error("未知请求");
            const input = schemas[method].parse(raw) as never;
            const value = isConnectorRequest(method)
              ? await connectors.requests(method, input)
              : await (
                  handlers[method] as (input: unknown) => Promise<unknown>
                )(input);
            return {
              ok: true,
              value: binaryRequests.has(method)
                ? value
                : redactStrings(value, redact),
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
        const rendererUrl =
          process.env.ELECTRON_RENDERER_URL && !app.isPackaged
            ? new URL(process.env.ELECTRON_RENDERER_URL).href
            : pathToFileURL(join(directory, "../renderer/index.html")).href;
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
        const bindPermissionReviewer = (ready: boolean) => {
          if (window?.webContents !== contents) return;
          permissionReviewer = ready
            ? Object.freeze({ webContentsId: contents.id })
            : undefined;
          permissionService.attachReviewer(permissionReviewer);
        };
        bindPermissionReviewer(true);
        // A document reload/crash must not finish an old asynchronous approval.
        // Detach until the next main-document navigation commits.
        contents.on("did-start-navigation", (details) => {
          if (details.isMainFrame && !details.isSameDocument)
            bindPermissionReviewer(false);
        });
        contents.on("did-navigate", () => bindPermissionReviewer(true));
        contents.on("render-process-gone", () => bindPermissionReviewer(false));
        contents.on("dom-ready", () => contents.setZoomFactor(1));
        // A reloaded renderer has no messages to apply incremental updates to.
        contents.on("did-start-loading", () => chatUpdates.reset());
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
        const ownedWindow = window;
        // Only the app document may write standard clipboard content. Embedded
        // previews, other windows, clipboard reads and other permissions stay denied.
        const canWriteClipboard = (
          contents: Electron.WebContents | null,
          permission: string,
          details: { isMainFrame: boolean; requestingUrl?: string },
        ) =>
          !ownedWindow.isDestroyed() &&
          window === ownedWindow &&
          contents === ownedWindow.webContents &&
          permission === "clipboard-sanitized-write" &&
          details.isMainFrame &&
          details.requestingUrl === rendererUrl &&
          contents.mainFrame.url === rendererUrl;
        window.webContents.session.setPermissionCheckHandler(
          (contents, permission, _origin, details) =>
            canWriteClipboard(contents, permission, details),
        );
        window.webContents.session.setPermissionRequestHandler(
          (contents, permission, callback, details) =>
            callback(canWriteClipboard(contents, permission, details)),
        );
        window.once("ready-to-show", () => window?.show());
        let closing = false;
        let readyToClose = false;
        ownedWindow.on("closed", () => {
          if (window === ownedWindow) {
            window = undefined;
            permissionReviewer = undefined;
            permissionService.attachReviewer(undefined);
          }
        });
        ownedWindow.on("close", (event) => {
          // before-quit already awaits AgentService.shutdown. Deferring this
          // close a second time cancels app.quit on macOS and leaves it running.
          if (readyToClose || quitting) return;
          event.preventDefault();
          if (closing) return;
          closing = true;
          mcp?.cancelLogins();
          providers?.shutdown();
          void (agents?.cancelAll() ?? Promise.resolve()).finally(() => {
            readyToClose = true;
            ownedWindow.close();
          });
        });
        void window.loadURL(rendererUrl);
      };
      createWindow();
      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
      });
    })
    .catch((error) => {
      // The renderer is not available yet, so follow the system language.
      const chinese = app.getLocale().startsWith("zh");
      dialog.showErrorBox(
        chinese ? "WorkLens 无法启动" : "WorkLens couldn’t start",
        error instanceof Error
          ? error.message
          : chinese
            ? "初始化失败"
            : "Initialization failed.",
      );
      app.quit();
    });
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    providers?.shutdown();
    permissions?.close();
    void Promise.allSettled([agents?.shutdown(), mcp?.shutdown()])
      .then(() => permissions?.flushAudit().catch(() => {}))
      .finally(() => app.quit());
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
