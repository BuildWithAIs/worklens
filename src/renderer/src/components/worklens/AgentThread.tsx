import { HtmlArtifactWorkspace } from "./HtmlArtifact";
import { useShimmer } from "@/hooks/use-shimmer";
import { toolProgress, toolActivityLabel, toolActivitySummary } from "@/lib/activity-progress";
import { ArtifactFiles } from "./ArtifactFiles";
import { activityIcon } from "@/lib/activity-icon";
import { systemText } from "@/lib/system-text";
import { useLocale } from "@/lib/locale";
import { useEffect, useMemo, useRef, useState, type PropsWithChildren } from "react";
import {
  AssistantRuntimeProvider,
  ExportedMessageRepository,
  type AppendMessage,
  type ThreadMessageLike,
  type ThreadMessage,
  type ToolCallMessagePartProps,
  useExternalStoreRuntime,
  useAuiState,
} from "@assistant-ui/react";
import { ToolFallback } from "@/components/assistant-ui/elements/tool-fallback.aui";
import {
  ReasoningRoot,
  ReasoningTrigger,
  ReasoningContent,
  ReasoningText,
} from "@/components/assistant-ui/elements/reasoning.aui";
import {
  Thread,
  type ThreadGroupPart,
} from "@/components/assistant-ui/elements/thread.aui";
import {
  ModelMenuContext,
  type ModelMenuProps,
} from "@/components/worklens/model-menu-context";
import type {
  ConversationView,
  MessageView,
} from "../../../../shared/contracts";

type Props = {
  view?: ConversationView;
  canSend: boolean;
  draft: string;
  onDraftLoaded: () => void;
  onSend: (text: string) => Promise<void>;
  onCancel: () => Promise<void>;
  modelMenu?: ModelMenuProps;
};

const activePhases = new Set([
  "generating",
  "tool",
  "compacting",
  "retrying",
  "stopping",
]);

function messageStatus(
  view: ConversationView | undefined,
  index: number,
  language: "en" | "zh",
) {
  const isLast = index === (view?.messages.length ?? 0) - 1;
  if (isLast && view && activePhases.has(view.phase))
    return { type: "running" as const };
  if (isLast && view?.phase === "cancelled")
    return { type: "incomplete" as const, reason: "cancelled" as const };
  if (isLast && view?.phase === "failed")
    return {
      type: "incomplete" as const,
      reason: "error" as const,
      error: view.error ? systemText(view.error, language) : undefined,
    };
  return { type: "complete" as const, reason: "stop" as const };
}

function parseArgs(value?: string) {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : { value: parsed };
  } catch {
    return { value };
  }
}

function toolResult(message: MessageView) {
  if (
    !message.status ||
    ["pending", "waiting", "running"].includes(message.status)
  )
    return undefined;
  return {
    status: message.status,
    output: message.text,
    ...(message.artifacts?.length ? { artifacts: message.artifacts } : {}),
    ...(message.targetPath ? { targetPath: message.targetPath } : {}),
    ...(message.shellCwd ? { shellCwd: message.shellCwd } : {}),
    ...(message.timeoutSeconds !== undefined
      ? { timeoutSeconds: message.timeoutSeconds }
      : {}),
    ...(message.exitCode !== undefined ? { exitCode: message.exitCode } : {}),
    ...(message.startedAt ? { startedAt: message.startedAt } : {}),
    ...(message.elapsed !== undefined ? { elapsed: message.elapsed } : {}),
  };
}

function convertMessage(
  view: ConversationView | undefined,
  language: "en" | "zh",
) {
  return (message: MessageView, index: number): ThreadMessageLike => {
    if (message.role === "user") {
      return {
        id: message.id,
        role: "user",
        content: message.text,
        metadata: { custom: { sentAt: message.createdAt } },
      };
    }

    if (message.role === "tool") {
      const startedAt = message.startedAt
        ? Date.parse(message.startedAt)
        : undefined;
      const completedAt =
        startedAt !== undefined && message.elapsed !== undefined
          ? startedAt + message.elapsed
          : undefined;
      return {
        id: message.id,
        role: "assistant",
        status: messageStatus(view, index, language),
        content: [
          {
            type: "tool-call",
            toolCallId: message.toolId ?? message.id,
            toolName: message.toolName ?? "tool",
            args: parseArgs(message.args) as never,
            argsText: message.args ?? "{}",
            result: toolResult(message),
            isError: ["error", "timeout", "cancelled"].includes(
              message.status ?? "",
            ),
            ...(startedAt !== undefined
              ? {
                  timing: {
                    startedAt,
                    ...(completedAt ? { completedAt } : {}),
                  },
                }
              : {}),
          },
        ],
      };
    }

    const content: Exclude<ThreadMessageLike["content"], string>[number][] = [];
    if (message.role === "summary") {
      content.push({
        type: "text",
        text: `### Context summary\n\n${message.text}`,
      });
    } else {
      if (message.thinking)
        content.push({ type: "reasoning", text: message.thinking });
      if (message.text) content.push({ type: "text", text: message.text });
    }
    return {
      id: message.id,
      role: "assistant",
      content,
      status: messageStatus(view, index, language),
    };
  };
}

function submittedText(message: AppendMessage) {
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n")
    .trim();
}

function WorkLensTool(props: ToolCallMessagePartProps) {
  const { t, language } = useLocale();
  const result = props.result as { status?: MessageView["status"] } | undefined;
  const summary = toolProgress(
    {
      id: props.toolCallId,
      role: "tool",
      text: "",
      toolName: props.toolName,
      args: props.argsText,
      status: result?.status ?? (props.isError ? "error" : "running"),
    },
    language,
  );
  return (
    <ToolFallback
      summary={toolActivityLabel(props.toolName, summary, props.status.type === "running", language)}
      icon={activityIcon(props.toolName)}
      {...props}
      toolName={
        props.isError
          ? `${props.toolName} · ${t("Failed", "失败")}`
          : props.toolName
      }
      status={
        props.isError ? { type: "incomplete", reason: "error" } : props.status
      }
    />
  );
}

function ActivityProgress({ progress, kind, active = true, summary }: { progress: string; kind: string; active?: boolean; summary?: string }) {
  const shimmerRef = useShimmer();
  const { language } = useLocale();
  const label = ["thinking", "working", "compacting", "retrying", "stopping"].includes(kind)
    ? progress : (!active && summary) || toolActivityLabel(kind, progress, active, language);
  const Icon = activityIcon(kind);
  return (
    <span data-slot="activity-progress" className="flex w-full min-w-0 items-start gap-2 text-sm leading-6 text-muted-foreground">
      {kind !== "thinking" && kind !== "working" && <Icon aria-hidden="true" className="mt-1 size-4 shrink-0" />}
      <span ref={shimmerRef} className={`min-w-0 truncate ${active ? "shimmer motion-reduce:animate-none" : ""}`}>{label}</span>
    </span>
  );
}

function WorkLensLiveStatus() {
  const custom = useAuiState((s) => s.message.metadata.custom);
  if (typeof custom.liveProgress !== "string" || !custom.liveProgress) return null;
  return <div className="mt-2"><ActivityProgress progress={custom.liveProgress} kind={String(custom.progressKind ?? "working")} active={custom.progressActive !== false} summary={typeof custom.toolSummary === "string" ? custom.toolSummary : undefined} /></div>;
}

function WorkLensToolGroup({
  children,
}: PropsWithChildren<{ group: ThreadGroupPart }>) {
  const { t } = useLocale();
  const content = useAuiState((s) => s.message.content);
  const tools = content.filter((part) => part.type === "tool-call");
  const artifacts = tools.flatMap((part) => {
    const result = part.result;
    return result && typeof result === "object" && "artifacts" in result && Array.isArray(result.artifacts) ? result.artifacts : [];
  });
  const failed = tools.filter((tool) => tool.isError).length;
  const running = useAuiState((s) => s.message.status?.type === "running");
  const progress = useAuiState((s) => s.message.metadata.custom.progress);
  const timing = useAuiState((s) => s.message.metadata.custom);
  const start =
    typeof timing.runStartedAt === "string"
      ? Date.parse(timing.runStartedAt)
      : NaN;
  const elapsed =
    typeof timing.runElapsedMs === "number" ? timing.runElapsedMs : undefined;
  const [now, setNow] = useState(Date.now);
  const [expanded, setExpanded] = useState(false);
  const open = running || expanded;
  useEffect(() => {
    if (running) setExpanded(false);
  }, [running]);
  useEffect(() => {
    if (!running || !Number.isFinite(start)) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running, start]);
  const seconds =
    running && Number.isFinite(start)
      ? Math.max(0, Math.floor((now - start) / 1000))
      : elapsed !== undefined
        ? Math.max(0, Math.round(elapsed / 1000))
        : undefined;
  const label =
    (running
      ? seconds !== undefined
        ? t(`Working for ${seconds}s`, `处理中 ${seconds} 秒`)
        : t("Working…", "处理中…")
      : seconds !== undefined
        ? t(`Worked for ${seconds}s`, `已处理 ${seconds} 秒`)
        : t("Thoughts", "思考过程")) +
    (failed ? t(` · ${failed} failed`, ` · ${failed} 次失败`) : "");
  return (
    <ReasoningRoot
      className="worklens-activity-section"
      data-running={running}
      data-show-progress={timing.showProgress !== false}
      variant="ghost"
      streaming={false}
      open={open}
      onOpenChange={setExpanded}
    >
      <div className="flex w-full min-w-0 flex-col items-start gap-1">
        <ReasoningTrigger
          className="shrink-0"
          disabled={running}
          active={false}
          label={label}
        />
      </div>
      {(!running || timing.showProgress !== false) && <ReasoningContent>
        <ReasoningText>
          {!running && children}
          {running && typeof progress === "string" && progress && (
            <ActivityProgress progress={progress} kind={String(timing.progressKind ?? "working")} active={timing.progressActive !== false} summary={typeof timing.toolSummary === "string" ? timing.toolSummary : undefined} />
          )}
        </ReasoningText>
      </ReasoningContent>}
      <ArtifactFiles result={{ artifacts }} />
    </ReasoningRoot>
  );
}

export function AgentThread({
  view,
  canSend,
  draft,
  onDraftLoaded,
  onSend,
  onCancel,
  modelMenu,
}: Props) {
  const { language } = useLocale();
  // Order live blocks by their first visible content, not an empty message shell.
  const liveOrder = useRef({ conversationId: view?.id, next: 0, ranks: new Map<string, number>() });
  // Presentation only: one activity disclosure per turn; source records stay intact.
  const messages = useMemo(() => {
    const convert = convertMessage(view, language);
    const displayed: ThreadMessageLike[] = [];
    const source = view?.messages ?? [];
    if (liveOrder.current.conversationId !== view?.id || !view || !activePhases.has(view.phase)) {
      liveOrder.current = { conversationId: view?.id, next: 0, ranks: new Map() };
    }
    let turn: { message: MessageView; index: number }[] = [];
    const flush = () => {
      if (!turn.length) return;
      // Keep full records for the completed disclosure; live rendering uses one status.
      // Only at turn end classify text preceding a tool as process narration;
      // the API has no progress/final channel, so never guess from wording.
      const status = messageStatus(view, turn[turn.length - 1].index, language);
      const running = status.type === "running";
      if (running) {
        const order = liveOrder.current;
        const latestSource = turn.at(-1);
        turn = turn.filter(entry => entry.message.role !== "assistant" || entry.message.text.trim() || entry === latestSource);
        for (const { message } of turn) {
          if ((message.role === "tool" || message.text.trim()) && !order.ranks.has(message.id)) {
            order.ranks.set(message.id, order.next++);
          }
        }
        turn.sort((a, b) => (order.ranks.get(a.message.id) ?? Infinity) - (order.ranks.get(b.message.id) ?? Infinity));
      }
      const lastTool = turn.findLastIndex(
        ({ message }) => message.role === "tool",
      );
      type Part = Exclude<ThreadMessageLike["content"], string>[number];
      const activity: Part[] = [];
      const answer: Part[] = [];
      let progress = "";
      for (const [position, { message, index }] of turn.entries()) {
        const converted = convert(message, index);
        if (!Array.isArray(converted.content)) continue;
        for (const part of converted.content) {
          // Raw reasoning is available only inside the completed disclosure.
          // During a live turn, expose its state, never its expanding transcript.
          if (running && (part.type === "reasoning" || (part.type === "text" && !part.text.trim()))) continue;
          if (part.type === "text" && !running && position < lastTool) {
            // Display-only reasoning part keeps narration inside the standard
            // process disclosure. The source text and message are untouched.
            activity.push({ type: "reasoning", text: part.text });
          } else if (part.type === "tool-call" || part.type === "reasoning") {
            activity.push(part);
          } else {
            answer.push(part);
          }
        }
      }
      const id = turn[0].message.id;
      const recordedTiming = turn.find(
        ({ message }) => message.runStartedAt,
      )?.message;
      const latestRun =
        turn.some(({ index }) => index === source.length - 1)
          ? view?.usage?.run
          : undefined;
      const runStartedAt = recordedTiming?.runStartedAt ?? latestRun?.startedAt;
      const runElapsedMs = recordedTiming?.runElapsedMs ?? latestRun?.elapsedMs;
      const latest = turn.at(-1)!.message;
      const latestTool = latest.role === "tool" ? latest : undefined;
      const phase = view?.phase;
      const progressKind =
        phase === "compacting" || phase === "retrying" || phase === "stopping"
          ? phase
          : latestTool
            ? (latestTool.toolName ?? "tool")
            : latest.thinking && !latest.text
              ? "thinking"
              : "working";
      // One replaceable live row; detailed records are rendered only after completion.
      progress =
        latestTool &&
        !["compacting", "retrying", "stopping"].includes(progressKind)
          ? toolProgress(latestTool, language)
          : progressKind === "compacting"
            ? language === "zh"
              ? "正在整理上下文"
              : "Compacting context"
            : progressKind === "retrying"
              ? language === "zh"
                ? "正在重试"
                : "Retrying"
              : progressKind === "stopping"
                ? language === "zh"
                  ? "正在停止"
                  : "Stopping"
                : progressKind === "thinking"
                  ? language === "zh"
                    ? "思考中"
                    : "Thinking"
                  : language === "zh"
                    ? "处理中"
                    : "Working";
      const progressActive =
        !latestTool ||
        ["compacting", "retrying", "stopping"].includes(progressKind) ||
        !["success", "error", "timeout", "cancelled"].includes(
          latestTool.status ?? "",
        );
      // Keep one stable part so tool/thinking transitions cannot grow the live DOM.
      const visibleActivity: Part[] = running
        ? [{ type: "reasoning", text: progress }]
        : activity;
      const liveTextSegments = running ? turn.flatMap(({ message }, position) =>
        message.role === "assistant" && message.text.trim() ? [{ message, position }] : [],
      ) : [];
      const prefixTool = liveTextSegments.length
        ? turn.slice(0, liveTextSegments[0].position).findLast(({ message }) => message.role === "tool")?.message
        : undefined;
      if (visibleActivity.length)
        displayed.push({
          id: `${id}-activity`,
          role: "assistant",
          content: visibleActivity,
          status,
          metadata: {
            custom: {
              progress: prefixTool ? toolProgress(prefixTool, language) : progress,
              progressKind: prefixTool ? prefixTool.toolName ?? "tool" : progressKind,
              progressActive: prefixTool ? false : progressActive,
              toolSummary: toolActivitySummary(turn.slice(0, liveTextSegments[0]?.position ?? turn.length).map(({ message }) => message), language),
              showProgress: answer.length === 0 || !!prefixTool,
              runStartedAt,
              runElapsedMs,
            },
          },
        });
      const sentAt = turn.findLast(
        ({ message }) => message.role === "assistant" && message.createdAt,
      )?.message.createdAt;
      if (running) {
        // Each source message owns its position. A later narration starts a new
        // block below the preceding tool summary rather than joining its text.
        for (const [segmentIndex, segment] of liveTextSegments.entries()) {
          const nextPosition = liveTextSegments[segmentIndex + 1]?.position ?? turn.length;
          const lastSegment = segmentIndex === liveTextSegments.length - 1;
          const segmentTool = turn.slice(segment.position + 1, nextPosition)
            .findLast(({ message }) => message.role === "tool")?.message;
          const liveProgress = lastSegment
            ? (progressKind !== "working" ? progress : undefined)
            : segmentTool ? toolProgress(segmentTool, language) : undefined;
          displayed.push({
            id: `${segment.message.id}-text`, role: "assistant",
            content: [{ type: "text", text: segment.message.text }],
            status: lastSegment ? status : { type: "complete", reason: "stop" },
            metadata: { custom: {
              sentAt: segment.message.createdAt, hasActivity: true, liveSegment: true,
              liveProgress,
              toolSummary: toolActivitySummary(turn.slice(segment.position + 1, nextPosition).map(({ message }) => message), language),
              progressKind: lastSegment ? progressKind : segmentTool?.toolName ?? "tool",
              progressActive: lastSegment && progressActive,
            } },
          });
        }
      } else if (answer.length) {
        displayed.push({
          id: `${id}-answer`, role: "assistant", content: answer, status,
          metadata: { custom: { sentAt, hasActivity: visibleActivity.length > 0 } },
        });
      }
      turn = [];
    };
    for (const [index, message] of source.entries()) {
      if (message.role === "user" || message.role === "summary") {
        flush();
        displayed.push(convert(message, index));
      } else {
        turn.push({ message, index });
      }
    }
    flush();
    return displayed;
  }, [view, language]);
  // The projection is an authoritative linear snapshot, not a branch update.
  // Array mode retains removed live nodes as alternative branches on completion.
  const messageRepository = useMemo(
    () => ExportedMessageRepository.fromArray(messages),
    [messages],
  );
  const runtime = useExternalStoreRuntime<ThreadMessage>({
    messageRepository,
    isRunning: !!view && activePhases.has(view.phase),
    isSendDisabled: !canSend,
    onNew: async (message) => {
      const text = submittedText(message);
      if (text) await onSend(text);
    },
    onCancel,
  });

  useEffect(() => {
    if (!draft) return;
    runtime.thread.composer.setText(draft);
    onDraftLoaded();
  }, [draft, onDraftLoaded, runtime]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ModelMenuContext.Provider value={modelMenu}>
        <HtmlArtifactWorkspace conversationId={view?.id} running={!!view && activePhases.has(view.phase)}><div className="agent-thread">
          <Thread
            components={{
              ToolFallback: WorkLensTool,
              ProcessGroup: WorkLensToolGroup,
              LiveStatus: WorkLensLiveStatus,
            }}
          />
        </div></HtmlArtifactWorkspace>
      </ModelMenuContext.Provider>
    </AssistantRuntimeProvider>
  );
}
