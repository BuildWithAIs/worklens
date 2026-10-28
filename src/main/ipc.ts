import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dialog, nativeTheme, shell, type BrowserWindow } from "electron";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Requests } from "../shared/contracts";
import type { AgentService } from "./agent-service";
import type { createConnectors } from "./connectors";
import type { ConnectorRequest } from "./connectors/ipc";
import { isExecutableFile } from "./executable-files";
import type { LocalArtifacts } from "./local-artifacts";
import type { McpService } from "./mcp-service";
import { discoverModels, selectModels } from "./model-selection";
import type { NetworkProxy } from "./network-proxy";
import type { ProviderService } from "./providers";
import { toolNames } from "./resources";
import type { SkillsService } from "./skills";
import type { StateStore } from "./storage";
import { externalUrl } from "./validation";

export type AppPaths = {
  root: string;
  runtime: string;
  sessions: string;
  userData: string;
  skills: string;
};
export interface RequestContext {
  paths: AppPaths;
  version: string;
  window: () => BrowserWindow | undefined;
  redact: (text: string) => string;
  state: StateStore;
  proxy: NetworkProxy;
  mcp: McpService;
  agents: AgentService;
  providers: ProviderService;
  skills: SkillsService;
  artifacts: LocalArtifacts;
  connectors: ReturnType<typeof createConnectors>;
  runtime: ModelRuntime;
}
type AppRequest = Exclude<keyof Requests, ConnectorRequest>;
export type RequestHandlers = {
  [K in AppRequest]: (
    input: Requests[K]["input"],
  ) => Promise<Requests[K]["output"]> | Requests[K]["output"];
};

async function openInChrome(path: string) {
  if (process.platform !== "darwin")
    throw new Error("Chrome opening is currently supported on macOS only");
  await promisify(execFile)("/usr/bin/open", ["-a", "Google Chrome", path]);
}
async function openPath(path: string) {
  const error = await shell.openPath(path);
  if (error) throw new Error(error);
}

export function requestHandlers(context: RequestContext): RequestHandlers {
  const {
    paths,
    state,
    proxy,
    mcp,
    agents,
    providers,
    skills,
    artifacts,
    connectors,
  } = context;
  return {
    mcpSave: (input) => mcp.save(input.config),
    mcpTest: (input) => mcp.test(input.name, paths.runtime, context.runtime),
    mcpLogin: (input) => mcp.login(input.name, input.loginId),
    mcpLogout: (input) => mcp.logout(input.name),
    jevConsentReply: (input) =>
      agents.replyJevConsent(
        input.conversationId,
        input.requestId,
        input.allow,
        input.autoAllow,
      ),
    jevConsentReset: (input) =>
      agents.resetJevConsent(input.conversationId, input.blocked),
    artifact: async (input) => {
      const artifact = await artifacts.get(input.id);
      if (input.action === "show") shell.showItemInFolder(artifact.path);
      else if (input.action === "open") {
        if (await isExecutableFile(artifact.path)) {
          shell.showItemInFolder(artifact.path);
          return { revealed: true };
        }
        await openPath(artifact.path);
      } else {
        const chosen = await dialog.showSaveDialog(context.window()!, {
          defaultPath: artifact.path,
          properties: ["showOverwriteConfirmation", "createDirectory"],
        });
        if (!chosen.canceled && chosen.filePath)
          await artifacts.copy(artifact.id, chosen.filePath);
      }
    },
    bootstrap: async () => {
      const catalog = await providers.list();
      await state.update((current) => discoverModels(current, catalog));
      return {
        settings: state.value,
        mcp: mcp.snapshot(),
        ...connectors.bootstrap(),
        providers: catalog,
        conversations: await agents.list(),
        globalUsage: agents.getGlobalUsage(),
        paths,
        version: context.version,
        tools: [
          ...toolNames,
          ...connectors.registry.names(),
          "tool_search",
          ...(state.value.codemodeEnabled !== false ? ["codemode"] : []),
        ],
        diagnostics: agents.diagnostics,
        recoveries: agents.recoveries,
      };
    },
    modelSelection: (input) =>
      state.update((current) => selectModels(current, input)),
    settings: async (input) => {
      const value = await state.update(input);
      nativeTheme.themeSource = state.value.theme;
      if (input.proxy) await proxy.apply(state.value.proxy);
      return value;
    },
    proxyDetect: (input) => proxy.detect(input.shell),
    proxyTest: (input) => proxy.test(input),
    proxyStatus: () => proxy.status(),
    providers: () => providers.list(),
    login: (input) =>
      providers.login(input.provider, input.type, input.loginId),
    authReply: (input) =>
      providers.reply(input.loginId, input.promptId, input.value),
    authCancel: (input) => {
      providers.cancel(input.loginId);
      mcp.cancel(input.loginId);
    },
    logout: (input) => providers.logout(input.provider),
    azure: (input) => providers.azure(input),
    test: (input) => providers.test(input),
    clearConnection: (input) => providers.clearConnection(input.provider),
    conversationFile: async (input) => {
      const file = await agents.conversationFile(
        input.id,
        input.path,
        input.action === "preview",
      );
      if (file.issue) return file;
      if (input.action === "reveal") shell.showItemInFolder(file.path);
      if (input.action === "open") {
        if (await isExecutableFile(file.path)) {
          shell.showItemInFolder(file.path);
          return { ...file, revealed: true };
        }
        await openPath(file.path);
      }
      if (input.action === "chrome") {
        if (file.kind !== "html")
          throw new Error("Chrome opening is unavailable");
        await openInChrome(file.path);
      }
      return file;
    },
    htmlFileAction: async (input) => {
      const file = await agents.htmlActionFile(input.id, {
        path: input.path,
        code: input.code,
      });
      if (input.action === "reveal") shell.showItemInFolder(file);
      else await openInChrome(file);
    },
    previewHtml: (input) => agents.previewHtml(input.id, input.path),
    open: async (input) => {
      const value = await agents.open(input.id);
      await state.update({ lastConversation: input.id });
      return value;
    },
    view: (input) => agents.open(input.id),
    rename: (input) => agents.rename(input.id, input.title),
    searchConversations: (input) => agents.search(input.query),
    prepareSearch: () => agents.prepareSearch(),
    cancelSearch: (input) => agents.cancelSearch(input.warmUp),
    delete: (input) => agents.delete(input.id),
    overview: (input) => agents.overview(input),
    reportSummary: (input) => agents.reportSummary(input),
    generateReportSummary: (input) => {
      const settings = state.value.reportSummary;
      if (!settings?.enabled) throw new Error("REPORT_SUMMARY_DISABLED");
      return agents.generateReportSummary(input, settings.models);
    },
    send: (input) => agents.send(input),
    editMessage: (input) => agents.editMessage(input),
    selectMessageVersion: (input) => agents.selectMessageVersion(input),
    recoverMessageEdit: (input) => agents.recoverMessageEdit(input),
    chatImage: (input) => agents.chatImage(input),
    prepareChatImage: (input) => agents.prepareChatImage(input),
    recoveryImages: async (input) =>
      (await agents.recoveryImages(input.runId)).map((image) => ({
        ...image,
        name: context.redact(image.name),
      })),
    cancel: (input) => agents.cancel(input.conversationId, input.runId),
    model: (input) => agents.setModel(input.id, input.selection),
    external: (input) => shell.openExternal(externalUrl(input.url)),
    showPath: async (input) => {
      await shell.openPath(paths[input.which]);
    },
    dismissRecovery: (input) => agents.dismissRecovery(input.runId),
    refreshModels: (input) => providers.refreshModels(input.provider),
    skillsList: () => skills.refresh(false),
    skillsRefresh: () => skills.refresh(),
    skillsToggle: (input) => skills.setEnabled(input.id, input.enabled),
    skillsReveal: (input) => shell.showItemInFolder(skills.pathOf(input.id)),
  };
}

// Image bytes are opaque binary payloads. Text redaction would corrupt them.
export const binaryRequests = new Set<keyof Requests>([
  "chatImage",
  "recoveryImages",
  "prepareChatImage",
]);
