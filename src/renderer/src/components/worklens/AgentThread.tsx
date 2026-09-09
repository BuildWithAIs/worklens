import { useEffect, useMemo } from "react";
import {
  AssistantRuntimeProvider,
  type AppendMessage,
  type ThreadMessageLike,
  type ToolCallMessagePartProps,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { CheckCircle2, ChevronDown, Clock3, XCircle } from "lucide-react";
import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import {
  ModelMenuContext,
  type ModelMenuProps,
} from "@/components/worklens/model-menu-context";
import type { ConversationView, MessageView } from "../../../../shared/contracts";

type Props = {
  view?: ConversationView;
  canSend: boolean;
  draft: string;
  onDraftLoaded: () => void;
  onSend: (text: string) => Promise<void>;
  onCancel: () => Promise<void>;
  modelMenu?: ModelMenuProps;
};

const activePhases = new Set(["generating", "tool", "compacting", "retrying", "stopping"]);

function messageStatus(view: ConversationView | undefined, index: number) {
  const isLast = index === (view?.messages.length ?? 0) - 1;
  if (isLast && view && activePhases.has(view.phase)) return { type: "running" as const };
  if (isLast && view?.phase === "cancelled")
    return { type: "incomplete" as const, reason: "cancelled" as const };
  if (isLast && view?.phase === "failed")
    return {
      type: "incomplete" as const,
      reason: "error" as const,
      error: view.error,
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
  if (!message.status || ["pending", "waiting", "running"].includes(message.status))
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

function convertMessage(view: ConversationView | undefined) {
  return (message: MessageView, index: number): ThreadMessageLike => {
    if (message.role === "user") {
      return { id: message.id, role: "user", content: message.text };
    }

    if (message.role === "tool") {
      const startedAt = message.startedAt ? Date.parse(message.startedAt) : undefined;
      const completedAt =
        startedAt !== undefined && message.elapsed !== undefined
          ? startedAt + message.elapsed
          : undefined;
      return {
        id: message.id,
        role: "assistant",
        status: messageStatus(view, index),
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
              ? { timing: { startedAt, ...(completedAt ? { completedAt } : {}) } }
              : {}),
          },
        ],
      };
    }

    const content: Exclude<ThreadMessageLike["content"], string>[number][] = [];
    if (message.role === "summary") {
      content.push({
        type: "text",
        text: `### 上下文摘要\n\n${message.text}`,
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
      status: messageStatus(view, index),
    };
  };
}

function submittedText(message: AppendMessage) {
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n")
    .trim();
}

type ToolResult = {
  status?: string;
  output?: string;
  targetPath?: string;
  shellCwd?: string;
  timeoutSeconds?: number;
  exitCode?: number | null;
  startedAt?: string;
  elapsed?: number;
};

function WorkLensTool({ toolName, argsText, result, status, isError }: ToolCallMessagePartProps) {
  const detail =
    result && typeof result === "object" && !Array.isArray(result)
      ? (result as ToolResult)
      : undefined;
  const running = status.type === "running";
  const cancelled = status.type === "incomplete" && status.reason === "cancelled";
  const state = running
    ? "running"
    : cancelled
      ? "cancelled"
      : isError
        ? "error"
        : "success";
  const label = running ? "执行中" : cancelled ? "已取消" : isError ? "失败" : "已完成";
  const StatusIcon = isError || cancelled ? XCircle : CheckCircle2;

  return (
    <details className={`tool-card ${state}`} open={running || isError}>
      <summary>
        {running ? <Clock3 className="spin" size={15} /> : <StatusIcon size={15} />}
        <strong>{toolName}</strong>
        <span className="tool-arg">{argsText.replace(/\s+/g, " ").slice(0, 95)}</span>
        <span className="tool-status">
          {label}
          {detail?.elapsed !== undefined ? ` · ${(detail.elapsed / 1000).toFixed(1)}s` : ""}
        </span>
        <ChevronDown size={14} />
      </summary>
      <div className="tool-detail">
        {detail?.shellCwd && (
          <>
            <label>命令初始目录</label>
            <pre>{detail.shellCwd}</pre>
            <p className="subtle">
              超时：{detail.timeoutSeconds === undefined ? "未设置" : `${detail.timeoutSeconds} 秒`}
              {detail.exitCode !== undefined
                ? ` · 退出码：${detail.exitCode === null ? "进程被终止" : detail.exitCode}`
                : ""}
            </p>
          </>
        )}
        {detail?.targetPath && (
          <>
            <label>目标绝对路径</label>
            <pre>{detail.targetPath}</pre>
          </>
        )}
        {detail?.startedAt && (
          <p className="subtle">
            开始时间：{new Date(detail.startedAt).toLocaleString("zh-CN")}
          </p>
        )}
        <label>参数</label>
        <pre>{argsText}</pre>
        {detail?.output && (
          <>
            <label>结果</label>
            <pre>{detail.output}</pre>
          </>
        )}
      </div>
    </details>
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
  const messages = view?.messages ?? [];
  const converter = useMemo(() => convertMessage(view), [view]);
  const runtime = useExternalStoreRuntime<MessageView>({
    messages,
    convertMessage: converter,
    isRunning: !!view && activePhases.has(view.phase),
    isSendDisabled: !canSend,
    onNew: async (message) => {
      const text = submittedText(message);
      if (text) await onSend(text);
    },
    onCancel,
    suggestions: [
      { title: "整理文件", label: "按内容归类并生成清单", prompt: "帮我整理这些文件，并生成一份清晰的目录说明。" },
      { title: "分析项目", label: "阅读代码并提出下一步", prompt: "分析当前项目，告诉我最值得优先处理的三个问题。" },
      { title: "起草文档", label: "从现有材料整理成文", prompt: "根据现有材料，帮我起草一份结构清楚的文档。" },
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
          <Thread components={{ ToolFallback: WorkLensTool }} />
        </div>
      </ModelMenuContext.Provider>
    </AssistantRuntimeProvider>
  );
}
