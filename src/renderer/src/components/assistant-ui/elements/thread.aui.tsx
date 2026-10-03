import { MessageEditingContext } from "@/components/worklens/message-editing-context";
import { Hint } from "@/components/ui/tooltip";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { languageTag, useAppTranslation } from "@/i18n";
("use client");

import {
  ComposerAddAttachment,
  ComposerAttachments,
  UserMessageAttachments,
} from "@/components/assistant-ui/elements/attachment.aui";
import { File } from "@/components/assistant-ui/elements/file";
import { Image } from "@/components/assistant-ui/elements/image";
import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text";
import {
  Reasoning,
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
  ReasoningTrigger,
} from "@/components/assistant-ui/elements/reasoning.aui";
import { ToolFallback } from "@/components/assistant-ui/elements/tool-fallback.aui";
import {
  ToolGroupContent,
  ToolGroupRoot,
  ToolGroupTrigger,
} from "@/components/assistant-ui/elements/tool-group.aui";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { ModelMenu } from "@/components/worklens/ModelMenu";
import { useModelMenuContext } from "@/components/worklens/model-menu-context";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  ActionBarMorePrimitive,
  ActionBarPrimitive,
  AuiIf,
  type AssistantState,
  BranchPickerPrimitive,
  ComposerPrimitive,
  ErrorPrimitive,
  groupPartByType,
  MessagePrimitive,
  ThreadPrimitive,
  type FileMessagePartComponent,
  type ImageMessagePartComponent,
  type ToolCallMessagePartComponent,
  type TextMessagePartProps,
  useAuiState,
  useAui,
} from "@assistant-ui/react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  LoaderCircleIcon,
  MicIcon,
  MoreHorizontalIcon,
  PencilIcon,
  RefreshCwIcon,
  SquareIcon,
} from "lucide-react";
import {
  startTransition,
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentType,
  type DragEvent,
  type FC,
  type PropsWithChildren,
  type ReactNode,
} from "react";

export type ThreadGroupPart = MessagePrimitive.GroupedParts.GroupPart;

/**
 * Optional component overrides for the thread. `AssistantMessage` and
 * `Welcome` replace whole sections; the remaining slots override how the
 * assistant message renders tool calls and part groups. Tool UIs registered
 * by name (toolkit `render`, `useAssistantDataUI`) take precedence over
 * `ToolFallback`.
 */
export type ThreadComponents = {
  EditComposer?: ComponentType;
  AssistantMessage?: ComponentType | undefined;
  Welcome?: ComponentType | undefined;
  ComposerInput?: ComponentType<{ autoFocus: boolean }>;
  ToolFallback?: ToolCallMessagePartComponent | undefined;
  ToolGroup?:
    | ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>>
    | undefined;
  LiveStatus?: ComponentType;
  MessageFooter?: ComponentType;
  ProcessGroup?: ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>>;
  ReasoningGroup?:
    | ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>>
    | undefined;
};

export type ThreadProps = {
  loadingStartedAt?: number;
  components?: ThreadComponents | undefined;
  autoFocus?: boolean | undefined;
  footer?: ReactNode;
  afterMessages?: ReactNode;
};

const EMPTY_COMPONENTS: ThreadComponents = {};

const ThreadComponentsContext =
  createContext<ThreadComponents>(EMPTY_COMPONENTS);

// Startup exposes a loading placeholder thread; treat it as a new chat so
// the composer mounts centered. Loads after startup keep the docked layout.
const isNewChatView = (s: AssistantState) =>
  s.thread.messages.length === 0 &&
  (!s.thread.isLoading || s.threads.isLoading);

// A switched thread that is still fetching its history must not show welcome.
const isHistoryLoadingView = (s: AssistantState) =>
  s.thread.messages.length === 0 &&
  s.thread.isLoading &&
  !s.thread.isDisabled &&
  !s.threads.isLoading;

export const ThreadLoadingIndicator: FC<{ startedAt?: number }> = ({
  startedAt,
}) => {
  const { t } = useAppTranslation();
  const [mountedAt] = useState(() => performance.now());
  const start = startedAt ?? mountedAt;
  const [visibleFor, setVisibleFor] = useState(() =>
    performance.now() - start >= 200 ? start : undefined,
  );
  useEffect(() => {
    // Use the same deadline for history fetching and preparation so the icon
    // does not disappear and reappear between those stages.
    const timer = setTimeout(
      () => setVisibleFor(start),
      Math.max(0, start + 200 - performance.now()),
    );
    return () => clearTimeout(timer);
  }, [start]);
  if (visibleFor !== start) return null;
  return (
    <div
      data-slot="thread-loading-indicator"
      role="status"
      className="text-muted-foreground absolute inset-0 flex items-center justify-center"
    >
      <LoaderCircleIcon
        aria-hidden="true"
        className="size-6 animate-spin motion-reduce:animate-none"
      />
      <span className="sr-only">{t("thread.loadingConversation")}</span>
    </div>
  );
};

export const Thread: FC<ThreadProps> = ({
  loadingStartedAt,
  components = EMPTY_COMPONENTS,
  autoFocus = true,
  footer,
  afterMessages,
}) => {
  const isEmpty = useAuiState(isNewChatView);

  return (
    <ThreadComponentsContext.Provider value={components}>
      <ThreadRoot
        loadingStartedAt={loadingStartedAt}
        isEmpty={isEmpty}
        autoFocus={autoFocus}
        footer={footer}
        afterMessages={afterMessages}
      />
    </ThreadComponentsContext.Provider>
  );
};

const ThreadRoot: FC<{
  loadingStartedAt?: number;
  isEmpty: boolean;
  autoFocus: boolean;
  footer?: ReactNode;
  afterMessages?: ReactNode;
}> = ({ loadingStartedAt, isEmpty, autoFocus, footer, afterMessages }) => {
  const { Welcome = ThreadWelcome } = useContext(ThreadComponentsContext);
  const messages = useAuiState((s) => s.thread.messages);
  const fetchingHistory = useAuiState(isHistoryLoadingView);
  const viewport = useRef<HTMLDivElement>(null);
  const { first, ready } = useProgressiveHistory(messages.length, viewport);
  const loading = fetchingHistory || !ready;

  return (
    <ThreadPrimitive.Root
      className="aui-root aui-thread-root bg-background @container relative flex h-full flex-col"
      aria-busy={loading}
      style={{
        ["--thread-max-width" as string]: isEmpty ? "760px" : "880px",
        ["--composer-bg" as string]: "var(--color-card)",
        ["--composer-radius" as string]: "1.5rem",
        ["--composer-padding" as string]: "8px",
      }}
    >
      {loading && <ThreadLoadingIndicator startedAt={loadingStartedAt} />}
      <ThreadPrimitive.Viewport
        ref={viewport}
        turnAnchor="top"
        data-slot="aui_thread-viewport"
        inert={loading}
        aria-hidden={loading || undefined}
        className={cn(
          "relative flex flex-1 flex-col overflow-x-auto overflow-y-scroll",
          loading && "invisible",
        )}
      >
        <div
          className={cn(
            "mx-auto flex w-full max-w-(--thread-max-width) flex-1 flex-col px-6 pt-4 md:px-10",
            isEmpty && "justify-center",
          )}
        >
          <AuiIf condition={isNewChatView}>
            <Welcome />
          </AuiIf>

          <div
            data-slot="aui_message-group"
            className="messages mb-14 flex w-full min-w-0 flex-col gap-y-6 empty:hidden"
          >
            <ProgressiveThreadMessages first={first} />
            {afterMessages}
          </div>

          <ThreadPrimitive.ViewportFooter
            className={cn(
              "aui-thread-viewport-footer bg-background mx-auto flex w-full flex-col gap-4 overflow-visible pb-4 md:pb-6",
              !isEmpty &&
                "sticky bottom-0 mt-auto rounded-t-(--composer-radius)",
            )}
          >
            <ThreadScrollToBottom />
            <Composer autoFocus={autoFocus} />
            {footer}
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
};

const ThreadMessage: FC = () => {
  const {
    AssistantMessage: AssistantMessageComponent = AssistantMessage,
    EditComposer: EditComposerComponent = EditComposer,
  } = useContext(ThreadComponentsContext);
  const role = useAuiState((s) => s.message.role);
  const isEditing = useAuiState((s) => s.message.composer.isEditing);

  const id = useAuiState((s) => s.message.id);
  const editing = useContext(MessageEditingContext);
  if (isEditing || editing?.editingId === id)
    return <EditComposerComponent key={editing?.recovered?.runId ?? id} />;
  if (role === "user") return <UserMessage />;
  return <AssistantMessageComponent />;
};

const messageComponents = { Message: ThreadMessage };

function useProgressiveHistory(
  messageCount: number,
  viewport: { current: HTMLDivElement | null },
) {
  const [start, setStart] = useState<number>();
  const [ready, setReady] = useState(messageCount === 0);
  const initialStart = Math.max(0, messageCount - 2);
  const first = Math.min(start ?? initialStart, initialStart);
  useEffect(() => {
    if (start === undefined && messageCount) setStart(first);
  }, [start, messageCount, first]);
  useEffect(() => {
    if (!first) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() => {
        startTransition(() => setStart(Math.max(0, first - 2)));
      }, 0);
    });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [first]);
  useEffect(() => {
    if (first || ready) return;
    let frame = requestAnimationFrame(() => {
      // Lay out and position hidden history before revealing it. Never animate
      // the initial scroll through a conversation's old messages.
      const element = viewport.current;
      element?.scrollTo({ top: element.scrollHeight, behavior: "instant" });
      frame = requestAnimationFrame(() => setReady(true));
    });
    return () => cancelAnimationFrame(frame);
  }, [first, ready, viewport]);
  return { first, ready };
}

function ProgressiveThreadMessages({ first }: { first: number }) {
  const messages = useAuiState((s) => s.thread.messages);
  // Start with the latest turn. Stable indices keep existing messages mounted
  // as older turns are prepended, and leaving the thread cancels the next batch.
  return (
    <div
      className="contents"
      data-slot="progressive-history"
      aria-busy={first > 0}
    >
      {messages.slice(first).map((_message, offset) => (
        <ThreadPrimitive.MessageByIndex
          key={first + offset}
          index={first + offset}
          components={messageComponents}
        />
      ))}
    </div>
  );
}

const ThreadScrollToBottom: FC = () => {
  const { t } = useAppTranslation();
  return (
    <ThreadPrimitive.ScrollToBottom
      render={
        <TooltipIconButton
          tooltip={t("thread.scrollToBottom")}
          variant="outline"
          className="aui-thread-scroll-to-bottom dark:border-border dark:bg-background dark:hover:bg-accent absolute -top-12 z-10 self-center rounded-full p-4 disabled:invisible"
        />
      }
    >
      <ArrowDownIcon />
    </ThreadPrimitive.ScrollToBottom>
  );
};

const ThreadWelcome: FC = () => {
  const { t } = useAppTranslation();
  return (
    <div className="aui-thread-welcome-root flex flex-col items-center px-4 text-center">
      <h1 className="aui-thread-welcome-message-inner fade-in slide-in-from-bottom-1 animate-in fill-mode-both text-2xl font-normal tracking-tight duration-200">
        {t("thread.whereShallWeStartQuestion")}
      </h1>
    </div>
  );
};

const Composer: FC<{ autoFocus: boolean }> = ({ autoFocus }) => {
  const { t } = useAppTranslation();
  const { ComposerInput } = useContext(ThreadComponentsContext);
  const disabled = useAuiState((s) => s.thread.isDisabled);
  const preventDisabledDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!disabled || !event.dataTransfer.types.includes("Files")) return;
    // A disabled dropzone must still prevent file drops from navigating away.
    event.preventDefault();
    event.dataTransfer.dropEffect = "none";
  };
  return (
    <ComposerPrimitive.Root className="aui-composer-root relative flex w-full flex-col">
      <ComposerPrimitive.AttachmentDropzone
        disabled={disabled}
        onDragEnterCapture={preventDisabledDrop}
        onDragOverCapture={preventDisabledDrop}
        onDropCapture={preventDisabledDrop}
        render={
          <div
            data-slot="aui_composer-shell"
            className="border-border/60 data-[dragging=true]:border-ring focus-within:border-border dark:border-muted-foreground/15 dark:focus-within:border-muted-foreground/30 flex w-full cursor-text flex-col gap-2 rounded-(--composer-radius) border bg-(--composer-bg) p-(--composer-padding) shadow-md shadow-black/5 dark:shadow-black/20 transition-[border-color,box-shadow] duration-200 motion-reduce:transition-none data-[dragging=true]:border-dashed data-[dragging=true]:bg-[color-mix(in_oklab,var(--color-accent)_50%,var(--color-background))]"
          />
        }
      >
        <ComposerAttachments />
        {ComposerInput ? (
          <ComposerInput autoFocus={autoFocus} />
        ) : (
          <ComposerPrimitive.Input
            placeholder={t("thread.doAnything")}
            className="aui-composer-input caret-primary placeholder:text-muted-foreground/60 max-h-48 min-h-10 w-full resize-none bg-transparent px-2.5 py-1 text-sm leading-6 outline-none"
            rows={1}
            autoFocus={autoFocus}
            enterKeyHint="send"
            aria-label={t("thread.message")}
          />
        )}
        <ComposerAction />
      </ComposerPrimitive.AttachmentDropzone>
    </ComposerPrimitive.Root>
  );
};

const composerActionClassName =
  "size-8 rounded-full bg-violet-500 text-white hover:bg-violet-600 dark:bg-violet-500 dark:hover:bg-violet-400 focus-visible:border-violet-400 focus-visible:ring-violet-400/40 disabled:bg-muted disabled:text-muted-foreground disabled:opacity-60 motion-reduce:transition-none motion-reduce:active:scale-100";

const ComposerAction: FC = () => {
  const { t } = useAppTranslation();
  const modelMenu = useModelMenuContext();
  return (
    <div className="aui-composer-action-wrapper relative flex items-center justify-between">
      <ComposerAddAttachment />
      <div className="flex items-center gap-1.5">
        {modelMenu && (
          <ModelMenu
            data={modelMenu.data}
            value={modelMenu.selection}
            onChange={modelMenu.onChange}
            onManage={modelMenu.onManage}
          />
        )}
        <AuiIf condition={(s) => s.thread.capabilities.dictation}>
          <AuiIf condition={(s) => s.composer.dictation == null}>
            <ComposerPrimitive.Dictate
              render={
                <TooltipIconButton
                  tooltip={t("thread.voiceInput")}
                  side="bottom"
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="aui-composer-dictate text-muted-foreground hover:text-foreground size-7 rounded-full"
                  aria-label={t("thread.startVoiceInput")}
                />
              }
            >
              <MicIcon className="aui-composer-dictate-icon size-4" />
            </ComposerPrimitive.Dictate>
          </AuiIf>
          <AuiIf condition={(s) => s.composer.dictation != null}>
            <ComposerPrimitive.StopDictation
              render={
                <TooltipIconButton
                  tooltip={t("thread.stopDictation")}
                  side="bottom"
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="aui-composer-stop-dictation text-destructive size-7 rounded-full"
                  aria-label={t("thread.stopVoiceInput")}
                />
              }
            >
              <SquareIcon className="aui-composer-stop-dictation-icon size-3.5 animate-pulse fill-current" />
            </ComposerPrimitive.StopDictation>
          </AuiIf>
        </AuiIf>
        <AuiIf condition={(s) => !s.thread.isRunning}>
          <ComposerPrimitive.Send
            render={
              <TooltipIconButton
                tooltip={t("thread.sendMessage")}
                side="bottom"
                type="button"
                variant="default"
                size="icon"
                className={cn("aui-composer-send", composerActionClassName)}
                aria-label={t("thread.sendMessage")}
              />
            }
          >
            <ArrowUpIcon className="aui-composer-send-icon size-4" />
          </ComposerPrimitive.Send>
        </AuiIf>
        <AuiIf condition={(s) => s.thread.isRunning}>
          <ComposerPrimitive.Cancel
            render={
              <TooltipIconButton
                tooltip={t("thread.stopTask")}
                side="bottom"
                type="button"
                variant="default"
                size="icon"
                className={cn("aui-composer-cancel", composerActionClassName)}
                aria-label={t("thread.stopTask")}
              />
            }
          >
            <SquareIcon
              aria-hidden="true"
              className="aui-composer-cancel-icon size-3 fill-current"
            />
          </ComposerPrimitive.Cancel>
        </AuiIf>
      </div>
    </div>
  );
};

const MessageError: FC = () => {
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="aui-message-error-root border-destructive bg-destructive/10 text-destructive dark:bg-destructive/5 mt-2 rounded-md border p-3 text-sm dark:text-red-200">
        <ErrorPrimitive.Message className="aui-message-error-message line-clamp-2" />
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
};

const AssistantMessage: FC = () => {
  const { t } = useAppTranslation();
  const {
    ToolFallback: ToolFallbackComponent = ToolFallback,
    ToolGroup,
    ReasoningGroup,
    ProcessGroup,
    LiveStatus,
    MessageFooter,
  } = useContext(ThreadComponentsContext);

  const toolOnly = useAuiState(
    (s) =>
      s.message.content.length > 0 &&
      s.message.content.every(
        (part) => part.type === "tool-call" || part.type === "reasoning",
      ),
  );
  const liveSegment = useAuiState(
    (s) => s.message.metadata.custom.liveSegment === true,
  );
  const hasActivity = useAuiState(
    (s) => s.message.metadata.custom.hasActivity === true,
  );
  const isLast = useAuiState((s) => s.message.isLast);
  const ACTION_BAR_PT = "pt-1.5";
  // Keep the action bar inside the contained root's paint box, then cancel its reserved space in flow.
  const ACTION_BAR_HEIGHT = `min-h-7.5 ${ACTION_BAR_PT}`;

  return (
    <MessagePrimitive.Root
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      data-has-activity={hasActivity}
      data-message-last={isLast}
      className={cn("relative", !toolOnly && !liveSegment && "-mb-7.5 pb-7.5")}
    >
      <div
        data-slot="aui_assistant-message-content"
        className="text-foreground leading-relaxed wrap-break-word"
      >
        <MessagePrimitive.GroupedParts
          groupBy={groupPartByType({
            reasoning: ["group-chainOfThought", "group-reasoning"],
            "tool-call": ["group-chainOfThought", "group-tool"],
            "standalone-tool-call": [],
          })}
        >
          {({ part, children }) => {
            switch (part.type) {
              case "group-chainOfThought":
                return ProcessGroup ? (
                  <ProcessGroup group={part}>{children}</ProcessGroup>
                ) : (
                  <div data-slot="aui_chain-of-thought">{children}</div>
                );
              case "group-tool":
                if (ProcessGroup) return <>{children}</>;
                if (ToolGroup) {
                  return <ToolGroup group={part}>{children}</ToolGroup>;
                }
                return (
                  <ToolGroupRoot variant="ghost">
                    <ToolGroupTrigger
                      count={part.indices.length}
                      active={part.status.type === "running"}
                    />
                    <ToolGroupContent>{children}</ToolGroupContent>
                  </ToolGroupRoot>
                );
              case "group-reasoning": {
                if (ProcessGroup)
                  return <div className="text-sm leading-7">{children}</div>;
                if (ReasoningGroup) {
                  return (
                    <ReasoningGroup group={part}>{children}</ReasoningGroup>
                  );
                }
                const running = part.status.type === "running";
                return (
                  <ReasoningRoot streaming={running}>
                    <ReasoningTrigger active={running} />
                    <ReasoningContent aria-busy={running}>
                      <ReasoningText>{children}</ReasoningText>
                    </ReasoningContent>
                  </ReasoningRoot>
                );
              }
              case "text":
                return <MarkdownText />;
              case "reasoning":
                return <Reasoning {...part} />;
              case "tool-call":
                return part.toolUI ?? <ToolFallbackComponent {...part} />;
              case "data":
                return part.dataRendererUI;
              case "file":
                return (
                  <div data-slot="aui_assistant-message-file" className="py-1">
                    <File {...part} />
                  </div>
                );
              case "image":
                return (
                  <div data-slot="aui_assistant-message-image" className="py-1">
                    <Image {...part} />
                  </div>
                );
              case "indicator":
                if (toolOnly || hasActivity) return null;
                return (
                  <span
                    data-slot="aui_assistant-message-indicator"
                    className="flex items-center gap-2 text-sm text-muted-foreground"
                    role="status"
                  >
                    {t("common.workingPlaceholder")}
                  </span>
                );
              default:
                return null;
            }
          }}
        </MessagePrimitive.GroupedParts>
        {LiveStatus && <LiveStatus />}
        <MessageError />
      </div>

      {!toolOnly && !liveSegment && MessageFooter && (
        <div
          data-slot="aui_assistant-message-attribution"
          className="pt-0.5 empty:hidden"
        >
          <MessageFooter />
        </div>
      )}

      {!toolOnly && !liveSegment && (
        <div
          data-slot="aui_assistant-message-footer"
          className={cn("ms-2 flex items-center", ACTION_BAR_HEIGHT)}
        >
          <BranchPicker />
          <AssistantActionBar />
        </div>
      )}
    </MessagePrimitive.Root>
  );
};

const MessageCopy: FC = () => {
  const aui = useAui();
  const { t } = useAppTranslation();
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  const hasText = useAuiState(
    (s) =>
      s.message.content.some(
        (part) => part.type === "text" && part.text.trim(),
      ) ||
      (s.message.role === "assistant" &&
        s.message.status?.type === "incomplete" &&
        s.message.status.reason === "error" &&
        s.message.status.error !== undefined),
  );
  if (!hasText) return null;
  return (
    <TooltipIconButton
      tooltip={isCopied ? t("common.copied") : t("thread.copyText")}
      onClick={() => {
        const message = aui.message();
        const text = message.getCopyText();
        const state = message.getState();
        const status = state.role === "assistant" ? state.status : undefined;
        const error =
          status?.type === "incomplete" && status.reason === "error"
            ? status.error
            : undefined;
        copyToClipboard(
          text.trim() || error === undefined ? text : String(error),
        );
      }}
    >
      {isCopied ? <CheckIcon /> : <CopyIcon />}
    </TooltipIconButton>
  );
};

const MessageTime: FC<{ className?: string }> = ({ className }) => {
  const { language } = useAppTranslation();
  const sentAt = useAuiState((s) => s.message.metadata.custom.sentAt);
  const date = typeof sentAt === "string" ? new Date(sentAt) : undefined;
  const validDate = date && !Number.isNaN(date.getTime()) ? date : undefined;
  if (!validDate) return null;
  return (
    <Hint content={validDate.toLocaleString(languageTag(language))}>
      <time
        tabIndex={0}
        className={cn("text-xs", className)}
        dateTime={validDate.toISOString()}
      >
        {validDate.toLocaleTimeString(languageTag(language), {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        })}
      </time>
    </Hint>
  );
};

const AssistantActionBar: FC = () => {
  const { t } = useAppTranslation();
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-assistant-action-bar-root text-muted-foreground animate-in fade-in col-start-3 row-start-2 -ms-1 flex items-center gap-1 duration-200"
    >
      <MessageCopy />
      <ActionBarPrimitive.Reload
        render={<TooltipIconButton tooltip={t("thread.regenerate")} />}
      >
        <RefreshCwIcon />
      </ActionBarPrimitive.Reload>
      <ActionBarMorePrimitive.Root>
        <ActionBarMorePrimitive.Trigger
          render={
            <TooltipIconButton
              tooltip={t("thread.more")}
              className="data-[state=open]:bg-accent"
            />
          }
        >
          <MoreHorizontalIcon />
        </ActionBarMorePrimitive.Trigger>
        <ActionBarMorePrimitive.Content
          side="bottom"
          align="start"
          sideOffset={6}
          className="aui-action-bar-more-content bg-popover text-popover-foreground data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:animate-out data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-[8rem] overflow-hidden rounded-xl border p-1.5"
        >
          <ActionBarPrimitive.ExportMarkdown
            render={
              <ActionBarMorePrimitive.Item className="aui-action-bar-more-item hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none" />
            }
          >
            <DownloadIcon className="size-4" />
            {t("thread.exportMarkdown")}
          </ActionBarPrimitive.ExportMarkdown>
        </ActionBarMorePrimitive.Content>
      </ActionBarMorePrimitive.Root>
      <MessageTime className="aui-assistant-message-time ml-2" />
    </ActionBarPrimitive.Root>
  );
};

const UserFilePart: FileMessagePartComponent = (part) => (
  <div data-slot="aui_user-message-file" className="py-1">
    <File {...part} />
  </div>
);

const UserImagePart: ImageMessagePartComponent = (part) => (
  <div data-slot="aui_user-message-image" className="py-1">
    <Image {...part} />
  </div>
);

const UserMessageText: FC<TextMessagePartProps> = ({ text }) => {
  const { t } = useAppTranslation();
  const id = useId();
  const contentRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const measure = () => setOverflows(content.scrollHeight > 280);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [text]);

  const collapsed = overflows && !expanded;
  return (
    <div>
      <div
        id={id}
        className={cn(collapsed && "max-h-[280px] overflow-hidden")}
        style={
          collapsed
            ? {
                maskImage:
                  "linear-gradient(to bottom, black calc(100% - 56px), transparent)",
              }
            : undefined
        }
      >
        <div ref={contentRef} className="whitespace-pre-wrap">
          {text}
        </div>
      </div>
      {overflows && (
        <Button
          variant="disclosure"
          size="sm"
          className="aui-user-message-toggle mt-2 gap-1.5 px-0 text-inherit hover:bg-transparent hover:text-inherit dark:hover:bg-transparent"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? t("thread.showLess") : t("thread.showMore")}
          {expanded ? (
            <ChevronUpIcon data-icon="inline-end" />
          ) : (
            <ChevronDownIcon data-icon="inline-end" />
          )}
        </Button>
      )}
    </div>
  );
};

const UserMessage: FC = () => {
  const messageId = useAuiState((s) => s.message.id);
  const hasContent = useAuiState((s) =>
    s.message.content.some(
      (part) => part.type !== "text" || part.text.trim().length > 0,
    ),
  );
  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      data-message-id={messageId}
      className="grid auto-rows-auto content-start gap-y-2 px-2 [contain-intrinsic-size:auto_200px] [content-visibility:auto] [&:where(>*)]:col-start-2"
      data-role="user"
    >
      <UserMessageAttachments />

      <div className="aui-user-message-content-wrapper relative col-start-2 min-w-0">
        {hasContent && (
          <div className="aui-user-message-content bg-(--user-message-bg) text-(--user-message-text) rounded-[18px] px-4 py-3 text-[14px] leading-[1.7] font-normal wrap-break-word empty:hidden">
            <MessagePrimitive.Parts
              components={{
                Text: UserMessageText,
                File: UserFilePart,
                Image: UserImagePart,
              }}
            />
          </div>
        )}
        <div className="aui-user-action-bar-wrapper mt-1 flex h-7 justify-end">
          <UserActionBar />
        </div>
      </div>

      <MessageVersionPicker />
    </MessagePrimitive.Root>
  );
};

const UserActionBar: FC = () => {
  const { t } = useAppTranslation();
  const editing = useContext(MessageEditingContext);
  const id = useAuiState((s) => s.message.id);
  const original = editing?.messages.find((message) => message.entryId === id);
  return (
    <ActionBarPrimitive.Root className="aui-user-action-bar-root flex items-center justify-end gap-1 text-muted-foreground">
      <MessageTime className="mr-2" />
      <MessageCopy />
      <TooltipIconButton
        tooltip={t("thread.edit")}
        className="aui-user-action-edit"
        disabled={!original || editing?.busy || !!editing?.editingId}
        onClick={() => editing?.begin(id)}
      >
        <PencilIcon />
      </TooltipIconButton>
    </ActionBarPrimitive.Root>
  );
};

const MessageVersionPicker: FC = () => {
  const editing = useContext(MessageEditingContext);
  const { t } = useAppTranslation();
  const id = useAuiState((s) => s.message.id);
  const message = editing?.messages.find((message) => message.entryId === id);
  const versions = message?.versions;
  if (!versions || versions.length < 2) return null;
  const index = versions.indexOf(id);
  const disabled = editing?.busy || !!editing?.editingId;
  return (
    <div
      data-slot="aui_user-branch-picker"
      className="aui-branch-picker-root text-muted-foreground col-span-full col-start-1 row-start-3 -me-1 inline-flex items-center justify-end text-xs"
    >
      <TooltipIconButton
        tooltip={t("thread.previousVersion")}
        disabled={disabled || index <= 0}
        onClick={() => void editing?.select(id, versions[index - 1])}
      >
        <ChevronLeftIcon />
      </TooltipIconButton>
      <span
        className="aui-branch-picker-state font-medium"
        aria-label={t("thread.versionPosition", {
          current: index + 1,
          total: versions.length,
        })}
      >
        {index + 1} / {versions.length}
      </span>
      <TooltipIconButton
        tooltip={t("thread.nextVersion")}
        disabled={disabled || index >= versions.length - 1}
        onClick={() => void editing?.select(id, versions[index + 1])}
      >
        <ChevronRightIcon />
      </TooltipIconButton>
    </div>
  );
};

const EditComposer: FC = () => {
  const { t } = useAppTranslation();
  return (
    <MessagePrimitive.Root
      data-slot="aui_edit-composer-wrapper"
      className="flex flex-col px-2 [contain-intrinsic-size:auto_200px] [content-visibility:auto]"
    >
      <ComposerPrimitive.Root className="aui-edit-composer-root border-border/60 dark:border-muted-foreground/15 ms-auto flex w-full max-w-(--user-message-max-width) cursor-text flex-col rounded-(--composer-radius) border bg-(--composer-bg)">
        <ComposerPrimitive.Input
          className="aui-edit-composer-input text-foreground min-h-14 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm outline-none"
          autoFocus
        />
        <div className="aui-edit-composer-footer mx-2.5 mb-2.5 flex items-center gap-1.5 self-end">
          <ComposerPrimitive.Cancel
            render={
              <Button
                variant="ghost"
                size="sm"
                className="h-8 rounded-full px-3.5"
              />
            }
          >
            {t("common.cancel")}
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send
            render={<Button size="sm" className="h-8 rounded-full px-3.5" />}
          >
            {t("thread.update")}
          </ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  );
};

const BranchPicker: FC<BranchPickerPrimitive.Root.Props> = ({
  className,
  ...rest
}) => {
  const { t } = useAppTranslation();
  return (
    <BranchPickerPrimitive.Root
      hideWhenSingleBranch
      className={cn(
        "aui-branch-picker-root text-muted-foreground -ms-2 me-2 inline-flex items-center text-xs",
        className,
      )}
      {...rest}
    >
      <BranchPickerPrimitive.Previous
        render={<TooltipIconButton tooltip={t("common.previous")} />}
      >
        <ChevronLeftIcon />
      </BranchPickerPrimitive.Previous>
      <span className="aui-branch-picker-state font-medium">
        <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
      </span>
      <BranchPickerPrimitive.Next
        render={<TooltipIconButton tooltip={t("common.next")} />}
      >
        <ChevronRightIcon />
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
};
