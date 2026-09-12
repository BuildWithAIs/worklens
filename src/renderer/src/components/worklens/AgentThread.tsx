import { toolProgress } from "@/lib/activity-progress";
import { BookOpen, FilePenLine, Globe, Images, ListFilter, SquareTerminal, Wrench } from "lucide-react";
import { systemText } from "@/lib/system-text";
import { useLocale } from "@/lib/locale";
import {
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";
import {
  AssistantRuntimeProvider,
  type AppendMessage,
  type ThreadMessageLike,
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

const displayMessage = (message: ThreadMessageLike) => message;

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
      return { id: message.id, role: "user", content: message.text, metadata: { custom: { sentAt: message.createdAt } } };
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
  const { t } = useLocale();
  return (
    <ToolFallback
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

function WorkLensToolGroup({
  children,
}: PropsWithChildren<{ group: ThreadGroupPart }>) {
  const { t } = useLocale();
  const content = useAuiState((s) => s.message.content);
  const tools = content.filter((part) => part.type === "tool-call");
  const latestToolName = tools.at(-1)?.toolName ?? "";
  const ProgressIcon = /search/i.test(latestToolName) ? Globe
    : /image|screenshot/i.test(latestToolName) ? Images
    : latestToolName === "read" ? BookOpen
    : /^(bash|powershell|shell|exec|terminal)$/i.test(latestToolName) ? SquareTerminal
    : /^(write|edit|apply_patch)$/i.test(latestToolName) ? FilePenLine
    : /^(ls|find|grep)$/i.test(latestToolName) ? ListFilter
    : Wrench;
  const failed = tools.filter((tool) => tool.isError).length;
  const running = useAuiState((s) => s.message.status?.type === "running");
  const progress = useAuiState((s) => s.message.metadata.custom.progress);
  const timing = useAuiState((s) => s.message.metadata.custom);
  const progressKey = String(timing.progressId ?? "");
  const settled = timing.progressSettled === true;
  const [dismissedProgress, setDismissedProgress] = useState<string | null>(null);
  useEffect(() => {
    if (!settled) { setDismissedProgress(null); return; }
    const timer = setTimeout(() => setDismissedProgress(progressKey), 900);
    return () => clearTimeout(timer);
  }, [progressKey, settled]);
  const start = typeof timing.runStartedAt === "string" ? Date.parse(timing.runStartedAt) : NaN;
  const elapsed = typeof timing.runElapsedMs === "number" ? timing.runElapsedMs : undefined;
  const [now, setNow] = useState(Date.now);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!running || !Number.isFinite(start)) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running, start]);
  const seconds = running && Number.isFinite(start)
    ? Math.max(0, Math.floor((now - start) / 1000))
    : elapsed !== undefined ? Math.max(0, Math.round(elapsed / 1000)) : undefined;
  const label =
    (running
      ? (seconds !== undefined ? t(`Thinking… ${seconds}s`, `思考中… ${seconds} 秒`) : t("Thinking…", "思考中…"))
      : seconds !== undefined
        ? t(`Worked for ${seconds}s`, `已处理 ${seconds} 秒`)
        : t("Thoughts", "思考过程")) +
    (failed ? t(` · ${failed} failed`, ` · ${failed} 次失败`) : "");
  return (
    <ReasoningRoot
      className="worklens-activity-section"
      data-running={running}
      variant="ghost"
      streaming={running}
      open={open}
      onOpenChange={setOpen}
    >
      <div className="flex w-full min-w-0 flex-col items-start gap-1">
        <ReasoningTrigger className="shrink-0" active={running} label={label} />
        {running && !open && !(settled && dismissedProgress === progressKey) && typeof progress === "string" && progress && (
          <span data-slot="activity-progress" data-settled={settled} className="flex w-full min-w-0 items-start gap-2 text-sm leading-6 text-muted-foreground">
            <ProgressIcon aria-hidden="true" className="mt-1 size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate" title={progress}>{progress}</span>
          </span>
        )}
      </div>
      <ReasoningContent>
        <ReasoningText>{children}</ReasoningText>
      </ReasoningContent>
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
  // Presentation only: one activity disclosure per turn; source records stay intact.
  const messages = useMemo(() => {
    const convert = convertMessage(view, language);
    const displayed: ThreadMessageLike[] = [];
    const source = view?.messages ?? [];
    let turn: { message: MessageView; index: number }[] = [];
    const flush = () => {
      if (!turn.length) return;
      // The API has no progress/final channel. Only text followed by a tool
      // is known to be intermediate; never classify by its wording.
      const lastTool = turn.findLastIndex(({ message }) => message.role === "tool");
      type Part = Exclude<ThreadMessageLike["content"], string>[number];
      const activity: Part[] = [];
      const answer: Part[] = [];
      let progress = "";
      let progressId = "";
      let progressSettled = false;
      for (const [position, { message, index }] of turn.entries()) {
        if (message.role === "tool") {
          progress = toolProgress(message, language);
          progressId = message.id;
          progressSettled = ["success", "error", "timeout", "cancelled"].includes(message.status ?? "");
        }
        const converted = convert(message, index);
        if (!Array.isArray(converted.content)) continue;
        for (const part of converted.content) {
          if (part.type === "text" && position < lastTool) {
            progress = part.text.replace(/\s+/g, " ").trim();
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
      const status = messageStatus(view, turn[turn.length - 1].index, language);
      const recordedTiming = turn.find(({ message }) => message.runStartedAt)?.message;
      const latestRun = turn[turn.length - 1].index === source.length - 1 ? view?.usage?.run : undefined;
      const runStartedAt = recordedTiming?.runStartedAt ?? latestRun?.startedAt;
      const runElapsedMs = recordedTiming?.runElapsedMs ?? latestRun?.elapsedMs;
      if (activity.length) displayed.push({
        id: `${id}-activity`, role: "assistant", content: activity, status,
        metadata: { custom: { progress, progressId, progressSettled, runStartedAt, runElapsedMs } },
      });
      const sentAt = turn.findLast(({ message }) => message.role === "assistant" && message.createdAt)?.message.createdAt;
      if (answer.length) displayed.push({
        id: `${id}-answer`, role: "assistant", content: answer, status,
        metadata: { custom: { sentAt } },
      });
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
  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage: displayMessage,
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
        <div className="agent-thread">
          <Thread
            components={{
              ToolFallback: WorkLensTool,
              ProcessGroup: WorkLensToolGroup,
            }}
          />
        </div>
      </ModelMenuContext.Provider>
    </AssistantRuntimeProvider>
  );
}
