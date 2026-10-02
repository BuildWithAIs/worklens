import { editParent, messageVersions, versionLeaf } from "./message-versions";
import { readHtmlPreview, htmlActionFile } from "./html-preview";
import {
  inspectConversationFile,
  previewConversationFile,
} from "./conversation-files";
import {
  createAgentSession,
  convertToLlm,
  buildSessionContext,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { LocalArtifacts } from "./local-artifacts";
import {
  ownedDirectory,
  sessionDirectory,
  sessionWorkspace,
} from "./session-files";
import { dirname, join, resolve } from "node:path";
import { mkdir, unlink, realpath, readFile, readdir } from "node:fs/promises";
import { appendFileSync, existsSync } from "node:fs";
import {
  UsageService,
  getConversationUsage,
  getLatestRun,
  buildContextUsage,
  readRetainedUsage,
  getHistoricalContext,
  auditSessionFile,
  incompleteUsage,
} from "./usage";
import { resources, toolNames } from "./resources";
import { worklensTools } from "./tools";
import { ConnectorRegistry } from "./connectors/registry";
import type { SkillsService } from "./skills";
import type { JevConsent } from "./connectors/jev/consent";
import type { McpService } from "./mcp-service";
import { withRunTiming, projectMessages, textContent } from "./projection";
import { SerialQueue, atomicJson, redactStrings } from "./storage";
import { validateChatImages, validateImageContent } from "./chat-images";
import {
  processChatImage,
  thumbnailOptions,
  originalOptions,
} from "./image-processing";
import {
  installImageRequestGuard,
  prepareImageContext,
} from "./image-requests";
import type { ChatImage } from "../shared/chat-images";
import type {
  Requests,
  ChatEvent,
  Conversation,
  ConversationView,
  MessageView,
  Phase,
  Selection,
  Recovery,
  UsageSnapshot,
} from "../shared/contracts";

interface ActiveRun {
  id: string;
  cancelled: boolean;
  done?: Promise<void>;
  sequence: number;
}
interface Runtime {
  manager: SessionManager;
  session?: AgentSession;
  integrationConfiguration?: string;
  active?: ActiveRun;
  phase: Phase;
  error?: string;
  statusDetail?: string;
  toolUpdates: Map<string, Partial<MessageView>>;
  updated: string;
  timer?: NodeJS.Timeout;
  usage?: UsageSnapshot;
  accountingDamaged?: boolean;
}
export class AgentService {
  private sessions = new Map<string, Runtime>();
  private operations = new SerialQueue();
  private requests = new Map<string, Promise<ConversationView>>();
  private stopping = false;
  private usage = new UsageService();
  private lookupModel = (provider: string, model: string) =>
    this.modelRuntime.getModel(provider, model);
  getGlobalUsage() {
    return this.usage.getGlobalUsage();
  }
  private refreshUsage(runtime: Runtime) {
    const entries = runtime.manager.getEntries();
    const activeId = [
      "generating",
      "tool",
      "compacting",
      "retrying",
      "stopping",
    ].includes(runtime.phase)
      ? runtime.active?.id
      : undefined;
    runtime.usage = {
      conversation: getConversationUsage(entries, this.lookupModel),
      run: getLatestRun(
        runtime.manager.getBranch(),
        this.lookupModel,
        activeId,
      ),
      context: runtime.session
        ? buildContextUsage(runtime.session.getContextUsage())
        : getHistoricalContext(
            runtime.manager,
            this.selection(runtime),
            this.lookupModel,
          ),
    };
    if (runtime.accountingDamaged) {
      runtime.usage.conversation = incompleteUsage(runtime.usage.conversation);
      if (runtime.usage.run)
        runtime.usage.run = {
          ...runtime.usage.run,
          ...incompleteUsage(runtime.usage.run),
        };
    }
    // A new manager can still be memory-only before its first assistant response.
    const file = runtime.manager.getSessionFile();
    if (file && existsSync(file))
      this.usage.update(
        runtime.manager.getSessionId(),
        runtime.usage.conversation,
      );
  }
  diagnostics: string[] = [];
  recoveries: Recovery[] = [];
  constructor(
    readonly modelRuntime: ModelRuntime,
    readonly paths: { runtime: string; sessions: string; userData: string },
    private emit: (event: ChatEvent) => void,
    private redact: (text: string) => string,
    private connectors = new ConnectorRegistry(),
    private skills?: SkillsService,
    private artifacts = new LocalArtifacts(
      join(dirname(paths.sessions), "artifacts"),
      paths.sessions,
    ),
    private jevConsent?: JevConsent,
    private mcp?: McpService,
    private codemodeEnabled: () => boolean = () => true,
  ) {}
  async initialize() {
    await Promise.all([
      mkdir(this.paths.runtime, { recursive: true }),
      mkdir(this.paths.sessions, { recursive: true }),
      mkdir(join(this.paths.userData, "runs"), { recursive: true }),
    ]);
    await this.usage.rebuild(() =>
      readRetainedUsage(this.paths, this.lookupModel, (message) =>
        this.diagnostics.push(message),
      ),
    );
    const pending = (await readdir(join(this.paths.userData, "runs"))).filter(
      (file) => file.endsWith(".pending.json"),
    );
    for (const file of pending) {
      try {
        const item = JSON.parse(
          await readFile(join(this.paths.userData, "runs", file), "utf8"),
        );
        if (
          item.version === 1 &&
          typeof item.text === "string" &&
          file === `${item.runId}.pending.json`
        )
          this.recoveries.push({
            editOf: typeof item.editOf === "string" ? item.editOf : undefined,
            runId: item.runId,
            conversationId: item.conversationId,
            text: item.text,
            selection: item.selection,
            startedAt: item.startedAt,
            imageCount: Array.isArray(item.images) ? item.images.length : 0,
          });
      } catch {
        this.diagnostics.push("有一份运行恢复记录无法读取，原文件已保留。");
      }
    }
    if (pending.length)
      this.diagnostics.push(
        `上次退出时有 ${pending.length} 个运行未完成。已保留中断记录；工具可能产生了副作用，请核对后继续。`,
      );
  }
  async dismissRecovery(runId: string) {
    if (!this.recoveries.some((r) => r.runId === runId))
      throw new Error("恢复记录不存在");
    await unlink(join(this.paths.userData, "runs", `${runId}.pending.json`));
    this.recoveries = this.recoveries.filter((r) => r.runId !== runId);
  }
  async recoveryImages(runId: string): Promise<ChatImage[]> {
    if (!this.recoveries.some((r) => r.runId === runId))
      throw new Error("恢复记录不存在");
    const item = JSON.parse(
      await readFile(
        join(this.paths.userData, "runs", `${runId}.pending.json`),
        "utf8",
      ),
    );
    const images = validateChatImages(item.images ?? []);
    await validateImageContent(images);
    return images;
  }
  async chatImage(input: {
    conversationId: string;
    messageId: string;
    index: number;
    variant?: "thumbnail" | "original";
  }) {
    const runtime = await this.get(input.conversationId);
    const entry = runtime.manager.getEntry(input.messageId);
    if (
      entry?.type !== "message" ||
      entry.message.role !== "user" ||
      !Array.isArray(entry.message.content)
    )
      throw new Error("CHAT_IMAGE_MISSING");
    const block = entry.message.content[input.index];
    if (block?.type !== "image") throw new Error("CHAT_IMAGE_MISSING");
    const [image] = validateChatImages([
      { name: "image", mimeType: block.mimeType, data: block.data },
    ]);
    const decoded = await processChatImage(
      image,
      input.variant === "thumbnail" ? thumbnailOptions : originalOptions,
    );
    return `data:${decoded.mimeType};base64,${decoded.data}`;
  }
  async prepareChatImage(input: { images: ChatImage[] }) {
    const [image] = validateChatImages(input.images);
    if (input.images.length !== 1) throw new Error("CHAT_IMAGE_INVALID");
    const decoded = await processChatImage(image, thumbnailOptions);
    return `data:${decoded.mimeType};base64,${decoded.data}`;
  }
  private assertSelection(selection: Selection) {
    const model = this.modelRuntime.getModel(
      selection.provider,
      selection.model,
    );
    if (!model) throw new Error("模型已不在 Pi 目录中，请重新选择");
    if (!getSupportedThinkingLevels(model).includes(selection.thinking))
      throw new Error("此模型不支持所选推理等级");
    return model;
  }
  private selection(runtime: Runtime): Selection | undefined {
    if (runtime.session?.model)
      return {
        provider: runtime.session.model.provider,
        model: runtime.session.model.id,
        thinking: runtime.session.thinkingLevel,
      };
    const context = runtime.manager.buildSessionContext();
    return context.model
      ? {
          provider: context.model.provider,
          model: context.model.modelId,
          thinking: context.thinkingLevel as Selection["thinking"],
        }
      : undefined;
  }
  private summary(id: string, runtime: Runtime): Conversation {
    return {
      id,
      title: runtime.manager.getSessionName() ?? "新会话",
      updatedAt: runtime.updated,
      phase: runtime.phase,
      selection: this.selection(runtime),
      runId: runtime.active?.id,
      error: runtime.error,
      statusDetail: runtime.statusDetail,
      revision: runtime.active?.sequence,
    };
  }
  private view(id: string, runtime: Runtime): ConversationView {
    const branch = runtime.manager.getBranch();
    const cwd = sessionWorkspace(this.paths.sessions, id);
    const messages = projectMessages(withRunTiming(branch), cwd);
    const versions = messageVersions(runtime.manager);
    for (const message of messages) {
      if (!message.entryId) continue;
      const group = versions.groups.get(versions.roots.get(message.entryId)!);
      if (group && group.length > 1) message.versions = group;
    }
    // During streaming the public agent state may not yet include the current assistant partial.
    if (runtime.session?.agent.state.streamingMessage)
      messages.push(
        ...projectMessages(
          [runtime.session.agent.state.streamingMessage],
          cwd,
        ).map((m) => ({ ...m, id: m.role === "tool" ? m.id : "stream" })),
      );
    const timings = new Map<string, { startedAt: string; elapsed?: number }>();
    for (const entry of branch) {
      if (
        entry.type !== "custom" ||
        entry.customType !== "worklens.tool-timing"
      )
        continue;
      const data = entry.data as
        | {
            version?: number;
            toolId?: string;
            startedAt?: string;
            elapsed?: number;
          }
        | undefined;
      if (
        data?.version === 1 &&
        typeof data.toolId === "string" &&
        typeof data.startedAt === "string" &&
        Number.isFinite(Date.parse(data.startedAt))
      ) {
        timings.set(data.toolId, {
          startedAt: data.startedAt,
          elapsed:
            typeof data.elapsed === "number" &&
            Number.isFinite(data.elapsed) &&
            data.elapsed >= 0
              ? data.elapsed
              : undefined,
        });
      }
    }
    for (const message of messages) {
      if (message.toolId && timings.has(message.toolId))
        Object.assign(message, timings.get(message.toolId));
      if (message.toolId && runtime.toolUpdates.has(message.toolId))
        Object.assign(message, runtime.toolUpdates.get(message.toolId));
    }
    return redactStrings(
      {
        ...this.summary(id, runtime),
        branchId: runtime.manager.getLeafId() ?? undefined,
        messages,
        usage: runtime.usage,
        jevConsent: this.jevConsent?.view(id),
      },
      this.redact,
    );
  }
  private publish(
    id: string,
    runtime: Runtime,
    type: string,
    immediate = false,
  ) {
    const active = runtime.active;
    if (!active) return;
    const dispatch = () => {
      runtime.timer = undefined;
      if (runtime.active !== active) return;
      this.emit({
        conversationId: id,
        runId: active.id,
        sequence: ++active.sequence,
        type,
        view: this.view(id, runtime),
        globalUsage: this.getGlobalUsage(),
      });
    };
    if (immediate) {
      if (runtime.timer) clearTimeout(runtime.timer);
      dispatch();
    } else if (!runtime.timer) runtime.timer = setTimeout(dispatch, 40);
  }
  connectorConsentChanged(id: string) {
    const runtime = this.sessions.get(id);
    if (runtime) this.publish(id, runtime, "connector_consent", true);
  }
  async replyJevConsent(
    id: string,
    requestId: string,
    allow: boolean,
    autoAllow = false,
  ) {
    const runtime = await this.get(id);
    if (!this.jevConsent || !runtime.active)
      throw new Error("Jev approval is no longer pending.");
    await this.jevConsent.reply(id, requestId, allow, autoAllow);
    return this.view(id, runtime);
  }
  async resetJevConsent(id: string, blocked: boolean) {
    const runtime = await this.get(id);
    if (!this.jevConsent) throw new Error("Jev is unavailable.");
    await this.jevConsent.reset(id, blocked);
    return this.view(id, runtime);
  }
  async list(): Promise<Conversation[]> {
    const found = await SessionManager.listAll(this.paths.sessions);
    const result = new Map<string, Conversation>();
    for (const info of found) {
      const cached = this.sessions.get(info.id);
      if (cached) {
        result.set(info.id, this.summary(info.id, cached));
        continue;
      }
      try {
        const manager = SessionManager.open(info.path, this.paths.sessions);
        const context = manager.buildSessionContext();
        result.set(info.id, {
          id: info.id,
          title: info.name || info.firstMessage?.slice(0, 48) || "未命名会话",
          updatedAt: info.modified.toISOString(),
          phase: "idle",
          selection: context.model
            ? {
                provider: context.model.provider,
                model: context.model.modelId,
                thinking: context.thinkingLevel as Selection["thinking"],
              }
            : undefined,
        });
      } catch (error) {
        this.diagnostics.push(
          this.redact(`会话 ${info.id} 无法打开：${String(error)}`),
        );
      }
    }
    for (const [id, runtime] of this.sessions)
      result.set(id, this.summary(id, runtime));
    return [...result.values()].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
  }
  private async get(id: string): Promise<Runtime> {
    const cached = this.sessions.get(id);
    if (cached) return cached;
    const info = (await SessionManager.listAll(this.paths.sessions)).find(
      (item) => item.id === id,
    );
    if (!info) throw new Error("会话不存在或 Pi 无法识别该文件");
    const manager = SessionManager.open(info.path, this.paths.sessions);
    if (manager.getSessionId() !== id) throw new Error("会话标识不匹配");
    const runtime: Runtime = {
      manager,
      phase: "idle",
      toolUpdates: new Map(),
      updated: info.modified.toISOString(),
      accountingDamaged: await auditSessionFile(info.path),
    };
    this.refreshUsage(runtime);
    this.sessions.set(id, runtime);
    return runtime;
  }
  open(id: string) {
    return this.operations.run(id, async () =>
      this.view(id, await this.get(id)),
    );
  }
  async conversationFile(id: string, path: string, preview = false) {
    return this.operations.run(id, async () => {
      const runtime = await this.get(id);
      const file = await inspectConversationFile(
        {
          cwd: sessionWorkspace(this.paths.sessions, id),
          roots: await this.previewRoots(runtime),
          messages: this.view(id, runtime).messages,
        },
        path,
      );
      return preview ? previewConversationFile(file) : file;
    });
  }
  async htmlActionFile(id: string, source: { path?: string; code?: string }) {
    return this.operations.run(id, async () => {
      const runtime = await this.get(id);
      const directory = join(
        sessionDirectory(this.paths.sessions, id),
        "previews",
      );
      await ownedDirectory(this.paths.sessions, directory, true);
      return htmlActionFile(
        await this.previewRoots(runtime),
        source,
        this.view(id, runtime).messages,
        directory,
      );
    });
  }
  async previewHtml(id: string, path: string) {
    return this.operations.run(id, async () => {
      const runtime = await this.get(id);
      return readHtmlPreview(
        await this.previewRoots(runtime),
        path,
        this.view(id, runtime).messages,
      );
    });
  }
  private async previewRoots(runtime: Runtime) {
    const id = runtime.manager.getSessionId();
    const directory = sessionDirectory(this.paths.sessions, id);
    await ownedDirectory(this.paths.sessions, directory);
    return [directory];
  }
  private async prepareSession(selection: Selection, requestedSkill?: string) {
    const model = this.assertSelection(selection);
    if (
      !(
        await this.modelRuntime.getAvailable(selection.provider, {
          signal: AbortSignal.timeout(15000),
        })
      ).some((m) => m.id === model.id)
    )
      throw new Error("模型尚未配置或不可用，请在设置中完成认证");
    const skillConfiguration = await this.skills?.configuration();
    if (
      requestedSkill &&
      !skillConfiguration?.resources.skills.some(
        (skill) => skill.name === requestedSkill,
      )
    )
      throw new Error("该技能未启用或已不存在，请在设置中检查技能");
    return { model, skillConfiguration };
  }
  private async ensureSession(
    runtime: Runtime,
    selection: Selection,
    requestedSkill?: string,
    prepared?: Awaited<ReturnType<AgentService["prepareSession"]>>,
  ) {
    const { model, skillConfiguration } =
      prepared ?? (await this.prepareSession(selection, requestedSkill));
    const integrationConfiguration =
      this.connectors.configurationKey() +
      "|" +
      (skillConfiguration?.key ?? "");
    const configuration =
      integrationConfiguration +
      "|" +
      (this.mcp?.configurationKey() ?? "") +
      "|" +
      this.codemodeEnabled();
    if (runtime.session && runtime.integrationConfiguration !== configuration) {
      await this.disposeSession(runtime);
      runtime.session = undefined;
    }
    if (!runtime.session) {
      const cwd = sessionWorkspace(
        this.paths.sessions,
        runtime.manager.getSessionId(),
      );
      await ownedDirectory(this.paths.sessions, cwd, true);
      const local = await resources(
        cwd,
        join(this.paths.userData, "pi"),
        {
          tools: this.connectors.names(),
          instructions: this.connectors.instructions(),
        },
        skillConfiguration?.resources,
        {
          mcp: this.mcp,
          codemode: this.codemodeEnabled(),
          redact: this.redact,
        },
      );
      const customTools = worklensTools(cwd, (toolId, status) => {
        runtime.toolUpdates.set(toolId, {
          ...runtime.toolUpdates.get(toolId),
          status,
        });
        this.publish(
          runtime.manager.getSessionId(),
          runtime,
          "tool_resource_status",
        );
      });
      const integrationTools = this.connectors.tools(
        runtime.manager.getSessionId(),
        () => runtime.active?.id ?? "idle",
      );
      const previous = runtime.manager.buildSessionContext();
      runtime.session = (
        await createAgentSession({
          cwd,
          agentDir: join(this.paths.userData, "pi"),
          modelRuntime: this.modelRuntime,
          model,
          thinkingLevel: selection.thinking,
          sessionManager: runtime.manager,
          customTools: [...customTools, ...integrationTools],
          ...local,
        })
      ).session;
      installImageRequestGuard(runtime.session.agent);
      await runtime.session.bindExtensions({
        uiContext: {
          ...runtime.session.extensionRunner.getUIContext(),
          notify: (message) => this.diagnostics.push(this.redact(message)),
        },
        onError: (error) => this.diagnostics.push(this.redact(error.error)),
      });
      if (
        previous.model &&
        (previous.model.provider !== model.provider ||
          previous.model.modelId !== model.id)
      )
        await runtime.session.setModel(model);
      if (
        previous.messages.length &&
        previous.thinkingLevel !== selection.thinking
      )
        runtime.session.setThinkingLevel(selection.thinking);
      runtime.integrationConfiguration = configuration;
      runtime.session.subscribe((event) => this.onPiEvent(runtime, event));
    } else {
      if (
        runtime.session.model?.id !== model.id ||
        runtime.session.model?.provider !== model.provider
      )
        await runtime.session.setModel(model);
      runtime.session.setThinkingLevel(selection.thinking);
    }
    runtime.session.setActiveToolsByName([
      ...toolNames,
      ...this.connectors.names(),
      "tool_search",
      ...(this.codemodeEnabled() ? ["codemode"] : []),
      ...runtime.session
        .getActiveToolNames()
        .filter(
          (name) =>
            name.startsWith("mcp__") ||
            [
              "list_mcp_resources",
              "list_mcp_resource_templates",
              "read_mcp_resource",
            ].includes(name),
        ),
    ]);
  }
  private onPiEvent(runtime: Runtime, event: AgentSessionEvent) {
    const active = runtime.active;
    if (!active) return;
    const id = runtime.manager.getSessionId();
    if (event.type === "tool_execution_start") {
      runtime.phase = active.cancelled ? "stopping" : "tool";
      const startedAt = new Date().toISOString();
      runtime.toolUpdates.set(event.toolCallId, {
        status: "running",
        startedAt,
        ...(event.parentToolCallId
          ? {
              ...projectMessages(
                [
                  {
                    role: "assistant",
                    content: [
                      {
                        type: "toolCall",
                        id: event.toolCallId,
                        name: event.toolName,
                        arguments: event.args,
                      },
                    ],
                  },
                ],
                sessionWorkspace(this.paths.sessions, id),
              )[0],
              status: "running" as const,
              parentToolCallId: event.parentToolCallId,
            }
          : {}),
      });
      if (event.parentToolCallId)
        runtime.manager.appendCustomEntry("worklens.nested-tool", {
          message: this.redactView(runtime.toolUpdates.get(event.toolCallId)),
        });
      runtime.manager.appendCustomEntry("worklens.tool-timing", {
        version: 1,
        conversationId: id,
        runId: active.id,
        toolId: event.toolCallId,
        startedAt,
      });
      // Crash journal records ownership, never tool arguments, output or secrets.
      appendFileSync(
        join(this.paths.userData, "runs", `${active.id}.log`),
        JSON.stringify({
          conversationId: id,
          runId: active.id,
          toolId: event.toolCallId,
          tool: event.toolName,
          state: "start",
          timestamp: Date.now(),
        }) + "\n",
      );
    } else if (event.type === "tool_execution_update") {
      runtime.toolUpdates.set(event.toolCallId, {
        ...runtime.toolUpdates.get(event.toolCallId),
        text: textContent(event.partialResult?.content).slice(-24000),
      });
    } else if (event.type === "tool_execution_end") {
      const previous = runtime.toolUpdates.get(event.toolCallId);
      const elapsed = previous?.startedAt
        ? Date.now() - Date.parse(previous.startedAt)
        : undefined;
      runtime.toolUpdates.set(event.toolCallId, {
        startedAt: previous?.startedAt,
        status:
          active.cancelled && event.isError
            ? "cancelled"
            : event.isError
              ? /Command timed out after \d+(?:\.\d+)? seconds\s*$/.test(
                  textContent(event.result?.content),
                )
                ? "timeout"
                : "error"
              : "success",
        elapsed,
      });
      if (event.parentToolCallId) {
        const projected = projectMessages(
          [
            {
              role: "worklensNestedTool",
              view: { ...previous },
            },
            {
              role: "toolResult",
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              ...event.result,
              isError: event.isError,
            },
          ],
          sessionWorkspace(this.paths.sessions, id),
        ).find((message) => message.role === "tool")!;
        const message = {
          ...projected,
          ...runtime.toolUpdates.get(event.toolCallId),
          parentToolCallId: event.parentToolCallId,
        };
        runtime.toolUpdates.set(event.toolCallId, message);
        runtime.manager.appendCustomEntry("worklens.nested-tool", {
          message: this.redactView(message),
        });
      }
      if (previous?.startedAt)
        runtime.manager.appendCustomEntry("worklens.tool-timing", {
          version: 1,
          conversationId: id,
          runId: active.id,
          toolId: event.toolCallId,
          startedAt: previous.startedAt,
          elapsed,
        });
      runtime.phase = active.cancelled ? "stopping" : "generating";
      appendFileSync(
        join(this.paths.userData, "runs", `${active.id}.log`),
        JSON.stringify({
          conversationId: id,
          runId: active.id,
          toolId: event.toolCallId,
          state: "end",
          timestamp: Date.now(),
        }) + "\n",
      );
    } else if (event.type === "compaction_start") runtime.phase = "compacting";
    else if (event.type === "auto_retry_start") {
      runtime.phase = "retrying";
      runtime.statusDetail = `第 ${event.attempt}/${event.maxAttempts} 次重试，等待 ${Math.ceil(event.delayMs / 1000)} 秒`;
    } else if (
      event.type === "compaction_end" ||
      event.type === "auto_retry_end"
    ) {
      runtime.phase = active.cancelled ? "stopping" : "generating";
      runtime.statusDetail = undefined;
      if (event.type === "compaction_end" && event.errorMessage)
        runtime.error = this.redact(event.errorMessage);
    }
    if (
      event.type === "message_end" ||
      event.type === "compaction_end" ||
      event.type === "auto_retry_end"
    ) {
      // Observe the durable append after Pi's synchronous message notifications.
      // The usage integration test also covers the upgraded transcript pipeline.
      queueMicrotask(() => {
        if (runtime.active !== active) return;
        try {
          this.refreshUsage(runtime);
          this.publish(id, runtime, event.type);
        } catch {
          this.diagnostics.push("用量更新暂时失败，将在本轮结束时重新核对。");
        }
      });
    } else this.publish(id, runtime, event.type);
  }
  private assertEditable(
    runtime: Runtime,
    messageId: string,
    expectedBranchId: string,
  ) {
    if (runtime.active) throw new Error("当前会话正在运行，请先停止");
    if (runtime.manager.getLeafId() !== expectedBranchId)
      throw new Error("MESSAGE_VERSION_CHANGED");
    const entry = runtime.manager
      .getBranch()
      .find((entry) => entry.id === messageId);
    if (entry?.type !== "message" || entry.message.role !== "user")
      throw new Error("MESSAGE_VERSION_MISSING");
    return entry;
  }
  private async moveBranch(runtime: Runtime, leaf: string | null) {
    await this.disposeSession(runtime);
    runtime.session = undefined;
    if (leaf) runtime.manager.branch(leaf);
    else runtime.manager.resetLeaf();
    runtime.toolUpdates.clear();
  }
  private async restoreBranch(runtime: Runtime, leaf: string | null) {
    await this.moveBranch(runtime, leaf);
    try {
      runtime.manager.appendCustomEntry("worklens.branch-selection", {
        version: 1,
      });
    } catch {
      // Pi updates its in-memory leaf before attempting to append to disk.
      // Never leave a failed marker as the parent of the next user message.
      await this.moveBranch(runtime, leaf);
      this.diagnostics.push(
        "会话分支恢复未能写入磁盘，已保留原记录和编辑草稿。",
      );
    }
  }
  selectMessageVersion(input: Requests["selectMessageVersion"]["input"]) {
    if (this.stopping) return Promise.reject(new Error("应用正在退出"));
    return this.operations.run(input.conversationId, async () => {
      const runtime = await this.get(input.conversationId);
      this.assertEditable(runtime, input.messageId, input.expectedBranchId);
      const { roots } = messageVersions(runtime.manager);
      if (
        !roots.has(input.targetId) ||
        roots.get(input.targetId) !== roots.get(input.messageId)
      )
        throw new Error("MESSAGE_VERSION_MISSING");
      if (input.targetId === input.messageId)
        return this.view(input.conversationId, runtime);
      return this.selectBranch(input.conversationId, runtime, input.targetId);
    });
  }
  recoverMessageEdit(input: Requests["recoverMessageEdit"]["input"]) {
    if (this.stopping) return Promise.reject(new Error("应用正在退出"));
    const recovery = this.recoveries.find((item) => item.runId === input.runId);
    if (!recovery?.editOf)
      return Promise.reject(new Error("MESSAGE_VERSION_MISSING"));
    return this.operations.run(recovery.conversationId, async () => {
      // The saved marker owns the conversation and target; renderer IDs cannot
      // navigate arbitrary hidden history or restore a dismissed recovery.
      if (!this.recoveries.includes(recovery))
        throw new Error("MESSAGE_VERSION_MISSING");
      const runtime = await this.get(recovery.conversationId);
      if (runtime.active) throw new Error("当前会话正在运行，请先停止");
      if (runtime.manager.getLeafId() !== input.expectedBranchId)
        throw new Error("MESSAGE_VERSION_CHANGED");
      const entry = runtime.manager.getEntry(recovery.editOf!);
      if (entry?.type !== "message" || entry.message.role !== "user")
        throw new Error("MESSAGE_VERSION_MISSING");
      return this.selectBranch(recovery.conversationId, runtime, entry.id);
    });
  }
  private async selectBranch(id: string, runtime: Runtime, targetId: string) {
    const previous = runtime.manager.getLeafId();
    try {
      await this.moveBranch(runtime, versionLeaf(runtime.manager, targetId));
      // Pi restores the last appended entry as its leaf on open.
      runtime.manager.appendCustomEntry("worklens.branch-selection", {
        version: 1,
      });
    } catch (error) {
      await this.moveBranch(runtime, previous);
      throw error;
    }
    runtime.phase = "idle";
    runtime.error = undefined;
    runtime.statusDetail = undefined;
    runtime.updated = new Date().toISOString();
    this.refreshUsage(runtime);
    return this.view(id, runtime);
  }
  send(input: Requests["send"]["input"]) {
    return this.submit(input);
  }
  editMessage(input: Requests["editMessage"]["input"]) {
    return this.submit({ ...input, images: undefined }, input);
  }
  private submit(
    input: Requests["send"]["input"],
    edit?: Requests["editMessage"]["input"],
  ): Promise<ConversationView> {
    if (this.stopping) return Promise.reject(new Error("应用正在退出"));
    const requestKey = `${input.conversationId ?? "new"}/${edit ? "edit" : "send"}/${input.requestId}`;
    if (this.requests.has(requestKey)) return this.requests.get(requestKey)!;
    const task = this.operations.run(
      input.conversationId ?? input.requestId,
      async () => {
        const editingRuntime = edit
          ? await this.get(edit.conversationId)
          : undefined;
        const original =
          edit && editingRuntime
            ? this.assertEditable(
                editingRuntime,
                edit.messageId,
                edit.expectedBranchId,
              )
            : undefined;
        const editedImages = edit?.images.map((image) => {
          if (!("existingIndex" in image)) return image;
          const content =
            original?.message.role === "user"
              ? original.message.content
              : undefined;
          const block = Array.isArray(content)
            ? content[image.existingIndex]
            : undefined;
          if (block?.type !== "image") throw new Error("CHAT_IMAGE_MISSING");
          return {
            name:
              (editingRuntime &&
                this.view(edit.conversationId, editingRuntime)
                  .messages.find(
                    (message) => message.entryId === edit.messageId,
                  )
                  ?.images?.find((ref) => ref.index === image.existingIndex)
                  ?.name) ||
              (block as { name?: string }).name ||
              `image-${image.existingIndex + 1}`,
            mimeType: block.mimeType,
            data: block.data,
          };
        });
        const images = validateChatImages(editedImages ?? input.images ?? []);
        if (!input.text.trim() && !images.length)
          throw new Error("消息不能为空");
        if (
          images.length &&
          !this.assertSelection(input.selection).input.includes("image")
        )
          throw new Error("CHAT_IMAGE_MODEL");
        let runtime: Runtime;
        if (input.conversationId)
          runtime = await this.get(input.conversationId);
        else {
          const id = randomUUID();
          runtime = {
            manager: SessionManager.create(
              sessionWorkspace(this.paths.sessions, id),
              this.paths.sessions,
              { id },
            ),
            phase: "idle",
            toolUpdates: new Map(),
            updated: new Date().toISOString(),
          };
        }
        if (runtime.active) throw new Error("当前会话正在运行，请先停止");
        // Exercise the model image budget before accepting/persisting the prompt.
        // IPC rejection lets the composer retain its text and attachments. The
        // stream guard still handles later tool images/context changes.
        // Preview the edit's prefix without moving the selected branch: the
        // replaced prompt and its continuation will not enter the new request.
        const contextMessages = edit
          ? buildSessionContext(
              runtime.manager.getEntries(),
              editParent(runtime.manager, edit.messageId),
            ).messages
          : (runtime.session?.messages ??
            runtime.manager.buildSessionContext().messages);
        await prepareImageContext(
          {
            messages: [
              ...convertToLlm(contextMessages),
              {
                role: "user",
                content: images.map((image) => ({
                  type: "image" as const,
                  data: image.data,
                  mimeType: image.mimeType,
                })),
                timestamp: Date.now(),
              },
            ],
          },
          this.assertSelection(input.selection),
        );
        const skillCommand = /^\/skill:([^\s]+)(?:\s+([\s\S]*))?$/.exec(
          input.text,
        );
        if (input.text.startsWith("/skill:") && !skillCommand)
          throw new Error("该技能未启用或已不存在，请在设置中检查技能");
        const prepared = await this.prepareSession(
          input.selection,
          skillCommand?.[1],
        );
        if (!edit)
          await this.ensureSession(
            runtime,
            input.selection,
            skillCommand?.[1],
            prepared,
          );
        const previousLeaf = runtime.manager.getLeafId();
        const prompt = skillCommand
          ? `/skill:${skillCommand[1]}${skillCommand[2] ? ` ${skillCommand[2]}` : ""}`
          : input.text;
        const id = runtime.manager.getSessionId();
        if (!runtime.manager.getSessionName() && !edit)
          runtime.session!.setSessionName(
            (input.text.trim() || images[0]?.name || "新会话").slice(0, 48),
          );
        this.sessions.set(id, runtime);
        const active: ActiveRun = {
          id: randomUUID(),
          cancelled: false,
          sequence: 0,
        };
        runtime.active = active;
        runtime.phase = "generating";
        runtime.error = undefined;
        runtime.statusDetail = undefined;
        runtime.updated = new Date().toISOString();
        // This is a recovery marker, not a duplicate conversation store.
        const pendingPath = join(
          this.paths.userData,
          "runs",
          `${active.id}.pending.json`,
        );
        try {
          await atomicJson(pendingPath, {
            version: 1,
            conversationId: id,
            runId: active.id,
            text: input.text,
            images,
            selection: input.selection,
            startedAt: runtime.updated,
            phase: "accepted",
            editOf: edit?.messageId,
          });
        } catch (error) {
          runtime.active = undefined;
          runtime.phase = "failed";
          throw error;
        }
        let runStartEntryId: string;
        try {
          // The draft is durable before any branch or model metadata changes.
          if (edit) {
            await this.moveBranch(
              runtime,
              editParent(runtime.manager, edit.messageId),
            );
            await this.ensureSession(
              runtime,
              input.selection,
              skillCommand?.[1],
              prepared,
            );
          }
          runStartEntryId = runtime.manager.appendCustomEntry(
            "worklens.run-start",
            {
              version: 1,
              conversationId: id,
              runId: active.id,
              ...input.selection,
              editOf: edit?.messageId,
              imageNames: images.map((image) => image.name),
              startedAt: runtime.updated,
            },
          );
          this.refreshUsage(runtime);
        } catch (error) {
          runtime.active = undefined;
          runtime.phase = "failed";
          if (edit) await this.restoreBranch(runtime, previousLeaf);
          // The accepted prompt remains in the recovery marker if attribution fails.
          throw error;
        }
        active.done = Promise.resolve().then(async () => {
          try {
            if (active.cancelled) return;
            await runtime.session!.prompt(prompt, {
              preflightResult: () => {
                if (active.cancelled) throw new Error("Run cancelled");
              },
              expandPromptTemplates: !!skillCommand,
              images: images.map((image) => ({
                type: "image" as const,
                ...image,
              })),
            });
            const last = [...runtime.session!.messages]
              .reverse()
              .find((m) => m.role === "assistant");
            if (last && "stopReason" in last && last.stopReason === "error")
              throw new Error(
                ("errorMessage" in last && String(last.errorMessage)) ||
                  "模型请求失败",
              );
            runtime.phase = active.cancelled ? "cancelled" : "completed";
          } catch (error) {
            runtime.phase = active.cancelled ? "cancelled" : "failed";
            if (!active.cancelled) runtime.error = this.redact(String(error));
          } finally {
            if (active.cancelled) runtime.phase = "cancelled";
            runtime.updated = new Date().toISOString();
            let terminalPersisted = false;
            try {
              this.refreshUsage(runtime);
              const runEndEntryId = runtime.manager.appendCustomEntry(
                "worklens.run-end",
                {
                  version: 1,
                  conversationId: id,
                  runId: active.id,
                  outcome: runtime.phase,
                  endedAt: runtime.updated,
                  usage: runtime.usage?.run
                    ? {
                        ...runtime.usage.run,
                        state: runtime.phase,
                        endedAt: runtime.updated,
                      }
                    : undefined,
                },
              );
              this.refreshUsage(runtime);
              // appendCustomEntry may only have updated memory. Verify the actual
              // canonical file contains both boundaries AND this run's user input.
              // Pi can reject auth or fail preflight before appending the prompt,
              // even when an existing session can persist our run-end marker.
              const file = runtime.manager.getSessionFile();
              if (file && existsSync(file)) {
                const persisted = SessionManager.open(
                  file,
                  this.paths.sessions,
                  this.paths.runtime,
                );
                const entries = persisted.getEntries();
                const run = getLatestRun(entries, this.lookupModel);
                const startIndex = entries.findIndex(
                  (entry) => entry.id === runStartEntryId,
                );
                const endIndex = entries.findIndex(
                  (entry) => entry.id === runEndEntryId,
                );
                terminalPersisted =
                  run?.runId === active.id &&
                  run.state === runtime.phase &&
                  startIndex >= 0 &&
                  endIndex > startIndex &&
                  entries
                    .slice(startIndex + 1, endIndex)
                    .some(
                      (entry) =>
                        entry.type === "message" &&
                        entry.message.role === "user",
                    );
              }
            } catch {
              this.diagnostics.push("本轮用量归档未完成，已保留恢复记录。");
            }
            try {
              const selectedBranch = runtime.manager.getBranch();
              const startPosition = selectedBranch.findIndex(
                (entry) => entry.id === runStartEntryId,
              );
              if (
                edit &&
                (startPosition < 0 ||
                  !selectedBranch
                    .slice(startPosition + 1)
                    .some(
                      (entry) =>
                        entry.type === "message" &&
                        entry.message.role === "user",
                    ))
              ) {
                await this.restoreBranch(runtime, previousLeaf);
                this.refreshUsage(runtime);
              }
              this.publish(id, runtime, "run_end", true);
            } catch {
              this.diagnostics.push("会话状态更新未完成，已保留恢复记录。");
              terminalPersisted = false;
            } finally {
              if (runtime.timer) clearTimeout(runtime.timer);
              runtime.timer = undefined;
              runtime.active = undefined;
            }
            if (terminalPersisted) await unlink(pendingPath).catch(() => {});
            else
              await atomicJson(pendingPath, {
                version: 1,
                conversationId: id,
                runId: active.id,
                text: input.text,
                images,
                selection: input.selection,
                startedAt: runtime.usage?.run?.startedAt,
                phase: runtime.phase,
                editOf: edit?.messageId,
                endedAt: runtime.updated,
              }).catch(() => {});
          }
        });
        this.publish(id, runtime, "run_start", true);
        return this.view(id, runtime);
      },
    );
    this.requests.set(requestKey, task);
    if (this.requests.size > 2000)
      this.requests.delete(this.requests.keys().next().value!);
    return task;
  }
  async cancel(id: string, runId: string) {
    const runtime = this.sessions.get(id);
    const active = runtime?.active;
    if (!runtime || !active || active.id !== runId) return;
    active.cancelled = true;
    runtime.phase = "stopping";
    this.publish(id, runtime, "run_stopping", true);
    await runtime.session?.abort();
    await active.done;
  }
  setModel(id: string, selection: Selection) {
    return this.operations.run(id, async () => {
      const runtime = await this.get(id);
      if (runtime.active) throw new Error("运行期间不能切换模型");
      await this.ensureSession(runtime, selection);
      this.refreshUsage(runtime);
      return this.view(id, runtime);
    });
  }
  rename(id: string, title: string) {
    return this.operations.run(id, async () => {
      const runtime = await this.get(id);
      runtime.manager.appendSessionInfo(title.trim());
      runtime.updated = new Date().toISOString();
    });
  }
  delete(id: string) {
    return this.operations.run(id, async () => {
      const runtime = await this.get(id);
      if (runtime.active) await this.cancel(id, runtime.active.id);
      const file = runtime.manager.getSessionFile();
      let sessionFile: string | undefined;
      if (file) {
        const actual = await realpath(file).catch((error) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (actual) {
          const expected = await realpath(this.paths.sessions);
          if (
            resolve(dirname(actual)).toLowerCase() !==
            resolve(expected).toLowerCase()
          )
            throw new Error("拒绝删除专属会话目录之外的文件");
          const checked = SessionManager.open(
            actual,
            this.paths.sessions,
            this.paths.runtime,
          );
          if (checked.getSessionId() !== id)
            throw new Error("会话文件标识不匹配");
          sessionFile = actual;
        }
      }
      await this.disposeSession(runtime);
      runtime.session = undefined;
      await this.artifacts.removeSession(id);
      await this.jevConsent?.forget(id);
      // Accepted prompts can outlive an unflushed Pi session. Delete their image
      // payloads together with the conversation, including markers from this run.
      for (const name of await readdir(join(this.paths.userData, "runs"))) {
        if (!name.endsWith(".pending.json")) continue;
        const path = join(this.paths.userData, "runs", name);
        const marker = await readFile(path, "utf8").then(
          (text) => {
            try {
              return JSON.parse(text);
            } catch {
              return undefined;
            }
          },
          () => undefined,
        );
        if (marker?.conversationId === id) await unlink(path);
      }
      this.recoveries = this.recoveries.filter(
        (item) => item.conversationId !== id,
      );
      if (sessionFile) await unlink(sessionFile);
      this.sessions.delete(id);
      this.usage.remove(id);
    });
  }
  async cancelAll() {
    await Promise.allSettled([...this.requests.values()]);
    await Promise.allSettled(
      [...this.sessions].map(async ([id, runtime]) => {
        if (runtime.active) await this.cancel(id, runtime.active.id);
      }),
    );
  }
  async shutdown() {
    this.stopping = true;
    await this.cancelAll();
    await Promise.allSettled(
      [...this.sessions.values()].map((runtime) =>
        this.disposeSession(runtime),
      ),
    );
  }
  private redactView<T>(value: T) {
    return redactStrings(value, this.redact);
  }
  private async disposeSession(runtime: Runtime) {
    if (!runtime.session) return;
    try {
      await runtime.session.extensionRunner.emit({
        type: "session_shutdown",
        reason: "quit",
      });
    } finally {
      runtime.session.dispose();
    }
  }
}
