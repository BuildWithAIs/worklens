import { systemText } from "@/lib/system-text";
import { useLocale } from "@/lib/locale";
import {
  useEffect,
  useMemo,
  useRef,
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
      return { id: message.id, role: "user", content: message.text };
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
  const failed = tools.filter((tool) => tool.isError).length;
  const running = useAuiState((s) => s.message.status?.type === "running");
  const progress = useAuiState((s) => s.message.metadata.custom.progress);
  const started = useRef<number | undefined>(undefined);
  const [seconds, setSeconds] = useState<number | undefined>();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (running) {
      started.current ??= Date.now();
      return;
    }
    if (started.current !== undefined) {
      setSeconds(
        Math.max(1, Math.round((Date.now() - started.current) / 1000)),
      );
      started.current = undefined;
    }
  }, [running]);
  const label =
    (running
      ? t("Thinking…", "思考中…")
      : seconds !== undefined
        ? t(`Worked for ${seconds}s`, `已处理 ${seconds} 秒`)
        : t("Thoughts", "思考过程")) +
    (failed ? t(` · ${failed} failed`, ` · ${failed} 次失败`) : "");
  return (
    <ReasoningRoot
      variant="ghost"
      streaming={running}
      open={open}
      onOpenChange={setOpen}
    >
      <div className="flex min-w-0 flex-col items-start gap-1">
        <ReasoningTrigger className="shrink-0" active={running} label={label} />
        {running && !open && typeof progress === "string" && progress && (
          <span data-slot="activity-progress" className="line-clamp-2 min-w-0 text-sm leading-6 text-muted-foreground wrap-anywhere">
            {progress}
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
  const { t, language } = useLocale();
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
      for (const [position, { message, index }] of turn.entries()) {
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
      if (activity.length) displayed.push({
        id: `${id}-activity`, role: "assistant", content: activity, status,
        metadata: { custom: { progress } },
      });
      if (answer.length) displayed.push({
        id: `${id}-answer`, role: "assistant", content: answer, status,
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
    suggestions: [
      {
        title: t("Organize files", "整理文件"),
        label: t("Sort and summarize", "按内容归类并生成清单"),
        prompt: t(
          "Organize these files and create a clear directory guide.",
          "帮我整理这些文件，并生成一份清晰的目录说明。",
        ),
      },
      {
        title: t("Explore a project", "分析项目"),
        label: t("Review code and next steps", "阅读代码并提出下一步"),
        prompt: t(
          "Analyze this project and identify the three highest priority issues.",
          "分析当前项目，告诉我最值得优先处理的三个问题。",
        ),
      },
      {
        title: t("Draft a document", "起草文档"),
        label: t("Turn notes into a draft", "从现有材料整理成文"),
        prompt: t(
          "Draft a well-structured document from the available material.",
          "根据现有材料，帮我起草一份结构清楚的文档。",
        ),
      },
    ],
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
