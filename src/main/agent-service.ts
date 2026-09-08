import {
  createAgentSession,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { mkdir, unlink, realpath, readFile, readdir } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { resources, toolNames } from "./resources";
import { worklensTools } from "./tools";
import { projectMessages, textContent } from "./projection";
import { SerialQueue, atomicJson, redactStrings } from "./storage";
import type {
  ChatEvent,
  Conversation,
  ConversationView,
  MessageView,
  Phase,
  Selection,
  Recovery,
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
  active?: ActiveRun;
  phase: Phase;
  error?: string;
  statusDetail?: string;
  toolUpdates: Map<string, Partial<MessageView>>;
  updated: string;
  timer?: NodeJS.Timeout;
}
export class AgentService {
  private sessions = new Map<string, Runtime>();
  private operations = new SerialQueue();
  private requests = new Map<string, Promise<ConversationView>>();
  private stopping = false;
  diagnostics: string[] = [];
  recoveries: Recovery[] = [];
  constructor(
    readonly modelRuntime: ModelRuntime,
    readonly paths: { runtime: string; sessions: string; userData: string },
    private emit: (event: ChatEvent) => void,
    private redact: (text: string) => string,
  ) {}
  async initialize() {
    await Promise.all([
      mkdir(this.paths.runtime, { recursive: true }),
      mkdir(this.paths.sessions, { recursive: true }),
      mkdir(join(this.paths.userData, "runs"), { recursive: true }),
    ]);
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
          this.recoveries.push(item);
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
    const messages = projectMessages(
      branch.flatMap<unknown>((entry) =>
        entry.type === "message"
          ? [entry.message]
          : entry.type === "compaction"
            ? [{ role: "compactionSummary", summary: entry.summary }]
            : [],
      ),
      this.paths.runtime,
    );
    // During streaming the public agent state may not yet include the current assistant partial.
    if (runtime.session?.agent.state.streamingMessage)
      messages.push(
        ...projectMessages(
          [runtime.session.agent.state.streamingMessage],
          this.paths.runtime,
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
      { ...this.summary(id, runtime), messages },
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
      });
    };
    if (immediate) {
      if (runtime.timer) clearTimeout(runtime.timer);
      dispatch();
    } else if (!runtime.timer) runtime.timer = setTimeout(dispatch, 40);
  }
  async list(): Promise<Conversation[]> {
    const found = await SessionManager.list(
      this.paths.runtime,
      this.paths.sessions,
    );
    const result = new Map<string, Conversation>();
    for (const info of found) {
      const cached = this.sessions.get(info.id);
      if (cached) {
        result.set(info.id, this.summary(info.id, cached));
        continue;
      }
      try {
        const manager = SessionManager.open(
          info.path,
          this.paths.sessions,
          this.paths.runtime,
        );
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
    const info = (
      await SessionManager.list(this.paths.runtime, this.paths.sessions)
    ).find((item) => item.id === id);
    if (!info) throw new Error("会话不存在或 Pi 无法识别该文件");
    const manager = SessionManager.open(
      info.path,
      this.paths.sessions,
      this.paths.runtime,
    );
    if (manager.getSessionId() !== id) throw new Error("会话标识不匹配");
    const runtime: Runtime = {
      manager,
      phase: "idle",
      toolUpdates: new Map(),
      updated: info.modified.toISOString(),
    };
    this.sessions.set(id, runtime);
    return runtime;
  }
  open(id: string) {
    return this.operations.run(id, async () =>
      this.view(id, await this.get(id)),
    );
  }
  private async ensureSession(runtime: Runtime, selection: Selection) {
    const model = this.assertSelection(selection);
    if (
      !(
        await this.modelRuntime.getAvailable(selection.provider, {
          signal: AbortSignal.timeout(15000),
        })
      ).some((m) => m.id === model.id)
    )
      throw new Error("模型尚未配置或不可用，请在设置中完成认证");
    if (!runtime.session) {
      const local = await resources(
        this.paths.runtime,
        join(this.paths.userData, "pi"),
      );
      const customTools = worklensTools(
        this.paths.runtime,
        (toolId, status) => {
          runtime.toolUpdates.set(toolId, {
            ...runtime.toolUpdates.get(toolId),
            status,
          });
          this.publish(
            runtime.manager.getSessionId(),
            runtime,
            "tool_resource_status",
          );
        },
      );
      const previous = runtime.manager.buildSessionContext();
      runtime.session = (
        await createAgentSession({
          cwd: this.paths.runtime,
          agentDir: join(this.paths.userData, "pi"),
          modelRuntime: this.modelRuntime,
          model,
          thinkingLevel: selection.thinking,
          sessionManager: runtime.manager,
          tools: toolNames,
          customTools,
          ...local,
        })
      ).session;
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
      runtime.session.subscribe((event) => this.onPiEvent(runtime, event));
    } else {
      if (
        runtime.session.model?.id !== model.id ||
        runtime.session.model?.provider !== model.provider
      )
        await runtime.session.setModel(model);
      runtime.session.setThinkingLevel(selection.thinking);
    }
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
    this.publish(id, runtime, event.type);
  }
  send(input: {
    conversationId?: string;
    requestId: string;
    text: string;
    selection: Selection;
  }): Promise<ConversationView> {
    if (this.stopping) return Promise.reject(new Error("应用正在退出"));
    if (this.requests.has(input.requestId))
      return this.requests.get(input.requestId)!;
    const task = this.operations.run(
      input.conversationId ?? input.requestId,
      async () => {
        let runtime: Runtime;
        if (input.conversationId)
          runtime = await this.get(input.conversationId);
        else
          runtime = {
            manager: SessionManager.create(
              this.paths.runtime,
              this.paths.sessions,
            ),
            phase: "idle",
            toolUpdates: new Map(),
            updated: new Date().toISOString(),
          };
        if (runtime.active) throw new Error("当前会话正在运行，请先停止");
        await this.ensureSession(runtime, input.selection);
        const id = runtime.manager.getSessionId();
        if (!runtime.manager.getSessionName())
          runtime.session!.setSessionName(input.text.trim().slice(0, 48));
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
            selection: input.selection,
            startedAt: runtime.updated,
            phase: "accepted",
          });
        } catch (error) {
          runtime.active = undefined;
          runtime.phase = "failed";
          throw error;
        }
        active.done = Promise.resolve().then(async () => {
          try {
            if (active.cancelled) return;
            await runtime.session!.prompt(input.text, {
              expandPromptTemplates: false,
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
            this.publish(id, runtime, "run_end", true);
            runtime.active = undefined;
            // Retain the accepted prompt if Pi has not yet created its session file.
            const file = runtime.manager.getSessionFile();
            if (file && (await realpath(file).catch(() => undefined)))
              await unlink(pendingPath).catch(() => {});
          }
        });
        this.publish(id, runtime, "run_start", true);
        return this.view(id, runtime);
      },
    );
    this.requests.set(input.requestId, task);
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
          await unlink(actual);
        }
      }
      runtime.session?.dispose();
      this.sessions.delete(id);
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
    for (const runtime of this.sessions.values()) runtime.session?.dispose();
  }
}
