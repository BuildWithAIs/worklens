import type { RecoveredEdit } from "./components/worklens/message-editing-context";
import {
  shortTitle,
  titleCharacters,
  RENAME_LIMIT,
} from "@/lib/conversation-title";
import { BackgroundEffect } from "@/components/worklens/BackgroundEffect";
import { BrandMark } from "@/components/worklens/BrandMark";
import { HistoryTitle } from "@/components/worklens/HistoryTitle";
import { Input } from "@/components/ui/input";
import { Hint, OverflowHint } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import {
  lazy,
  startTransition,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Plus,
  Search,
  MoreHorizontal,
  Settings as SettingsIcon,
  X,
  Trash2,
  Pencil,
  Pin,
  PinOff,
  LoaderCircle,
} from "lucide-react";
import type { SettingsSection } from "@/components/worklens/SettingsPage";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { imageFileError, systemText } from "@/lib/system-text";
import { shortFileName } from "@/lib/link-label";
import { useAppTranslation } from "@/i18n";
import { UsagePopover } from "@/components/worklens/UsagePopover";
import { newerGlobalUsage } from "../../shared/usage";
import { AgentThread } from "@/components/worklens/AgentThread";
import {
  ConversationSearch,
  type SearchSelection,
} from "@/components/worklens/ConversationSearch";
import { clearSearchHighlight, revealSearchMatch } from "@/lib/search-reveal";
import { ThreadLoadingIndicator } from "@/components/assistant-ui/elements/thread.aui";
import type { ChatImage } from "../../shared/chat-images";
import type {
  Bootstrap,
  GlobalUsage,
  ConversationView,
  Phase,
  Selection,
  Settings,
} from "../../shared/contracts";

const api = window.worklens;
const isMac = /Mac/i.test(navigator.platform);
const retainedViews = 8;
// Settings load separately from the chat; idle time preloads them.
const loadSettingsPage = () => import("@/components/worklens/SettingsPage");
const SettingsPage = lazy(() =>
  loadSettingsPage().then((module) => ({ default: module.SettingsPage })),
);
const active = (phase?: Phase) =>
  !!phase &&
  ["generating", "tool", "compacting", "retrying", "stopping"].includes(phase);
// Paint the selected row and loading shell before requesting history.
const afterPaint = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
  });

export function App() {
  const { t, i18n, language } = useAppTranslation();
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>("general");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem("worklens.sidebarCollapsed") === "true";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(
        "worklens.sidebarCollapsed",
        String(sidebarCollapsed),
      );
    } catch {
      /* Keep the toggle usable when storage is unavailable. */
    }
  }, [sidebarCollapsed]);
  const [data, setData] = useState<Bootstrap>();
  const [views, setViews] = useState<Record<string, ConversationView>>({});
  // Incremental chat events are applied to the latest views synchronously.
  const viewsRef = useRef<Record<string, ConversationView>>({});
  const [current, setCurrent] = useState<string>();
  const currentRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    currentRef.current = current;
  }, [current]);
  const [readyConversation, setReadyConversation] = useState<string>();
  const [historyStartedAt, setHistoryStartedAt] = useState<number>();
  const [historyLoad, setHistoryLoad] = useState<{
    id: string;
    failed: boolean;
  }>();
  const [page, setPage] = useState<"chat" | "settings">("chat");
  const [searchOpen, setSearchOpen] = useState(false);
  const [reveal, setReveal] = useState<SearchSelection & { query: string }>();
  const pinSaving = useRef(false);
  const [pinPending, setPinPending] = useState(false);
  const [unread, setUnread] = useState<Set<string>>(() => new Set());
  const visibleConversation = useRef<string | undefined>(undefined);
  const notifiedRuns = useRef(new Set<string>());
  useEffect(() => {
    const visible =
      page === "chat" && !historyLoad && readyConversation === current
        ? current
        : undefined;
    visibleConversation.current = visible;
    if (visible)
      setUnread((previous) => {
        if (!previous.has(visible)) return previous;
        const next = new Set(previous);
        next.delete(visible);
        return next;
      });
  }, [current, page, historyLoad, readyConversation]);
  // Reveal a search match once the conversation's full history has rendered.
  const revealReady =
    !!reveal &&
    page === "chat" &&
    !historyLoad &&
    current === reveal.id &&
    readyConversation === reveal.id;
  useEffect(() => {
    if (!revealReady || !reveal) return;
    const frame = requestAnimationFrame(() => {
      const thread = document.querySelector('[data-slot="aui_message-group"]');
      if (thread) revealSearchMatch(thread, reveal.query, reveal.messageId);
      setReveal(undefined);
    });
    return () => cancelAnimationFrame(frame);
  }, [revealReady, reveal]);
  useEffect(() => {
    // Navigating elsewhere before the result loaded cancels the reveal.
    if (reveal && !historyLoad && current !== reveal.id) setReveal(undefined);
  }, [reveal, historyLoad, current]);
  useEffect(() => () => clearSearchHighlight(), [current]);
  const markHistoryReady = useCallback(
    () => setReadyConversation(current),
    [current],
  );
  const [selection, setSelection] = useState<Selection>();
  const [text, setText] = useState("");
  const [draftImages, setDraftImages] = useState<ChatImage[]>([]);
  const [recoveredEdit, setRecoveredEdit] = useState<RecoveredEdit>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<{
    type: "error" | "success";
    text: string;
  }>();
  const notifyError = useCallback(
    (text: string) => setNotice({ type: "error", text }),
    [],
  );
  const notifySuccess = useCallback(
    (text: string) => setNotice({ type: "success", text }),
    [],
  );
  useEffect(() => {
    if (!notice) return;
    const englishText = systemText(notice.text.replace(/^Error: /, ""), "en");
    const english = i18n.getFixedT("en");
    const isModelSwitchReminder =
      notice.type === "error" &&
      englishText === english("system.cantSwitchModels");
    const needsSettings =
      notice.type === "error" &&
      [
        english("system.connectProvider"),
        english("system.modelUnavailable"),
      ].some((message) => message === englishText);
    const fileError = imageFileError(notice.text, language);
    let disposed = false;
    const id = toast.add({
      title: needsSettings ? (
        t("app.connectAProviderToStartChatting")
      ) : fileError ? (
        <span title={fileError.name}>{shortFileName(fileError.name, 32)}</span>
      ) : (
        systemText(notice.text.replace(/^Error: /, ""), language)
      ),
      description: fileError?.message,
      onClose: () => {
        if (!disposed)
          setNotice((current) => (current === notice ? undefined : current));
      },
      type: isModelSwitchReminder ? "info" : notice.type,
      timeout: notice.type === "error" ? 0 : 3200,
      priority: notice.type === "error" ? "high" : "low",
      actionProps: needsSettings
        ? {
            children: t("app.openSettings"),
            onClick: () => {
              setSettingsSection("providers");
              setPage("settings");
              setNotice(undefined);
            },
          }
        : undefined,
    });
    return () => {
      disposed = true;
      toast.close(id);
    };
  }, [notice, i18n, language, t]);
  const [pendingSends, setPendingSends] = useState(new Set<string>());
  const [draftId, setDraftId] = useState(() => crypto.randomUUID());
  const navigation = useRef(0);
  const submissionLocks = useRef(new Set<string>());
  const [dialog, setDialog] = useState<{
    type: "delete" | "rename";
    id: string;
    title: string;
  }>();
  const [deleting, setDeleting] = useState(false);
  const deletionPending = useRef(false);
  const deletedConversations = useRef(new Set<string>());
  const [showRecovery, setShowRecovery] = useState(true);
  const sequences = useRef(new Map<string, number>());
  const latestRuns = useRef(new Map<string, string>());
  const globalUsage = useRef<GlobalUsage | undefined>(undefined);
  const currentView = current ? views[current] : undefined;
  const loadingHistory = historyLoad;
  const selectedConversation = historyLoad?.id ?? current;
  const currentConversation =
    data?.conversations.find((item) => item.id === selectedConversation) ??
    (!historyLoad ? currentView : undefined);
  const busy = active(currentView?.phase);
  const sending = pendingSends.has(current ?? draftId);
  const refresh = useCallback(async () => {
    const next = await api.invoke("bootstrap", undefined);
    globalUsage.current = newerGlobalUsage(
      globalUsage.current,
      next.globalUsage,
    );
    setData({
      ...next,
      globalUsage: globalUsage.current,
      conversations: next.conversations.filter(
        (conversation) => !deletedConversations.current.has(conversation.id),
      ),
    });
    return next;
  }, []);
  const acceptView = useCallback((view: ConversationView) => {
    if (deletedConversations.current.has(view.id)) return;
    if (
      view.runId &&
      (sequences.current.get(`${view.id}/${view.runId}`) ?? 0) >
        (view.revision ?? 0)
    )
      return;
    // Keep recent, running and current conversations; others reload on open.
    const next = { ...viewsRef.current };
    delete next[view.id];
    next[view.id] = view;
    const ids = Object.keys(next);
    for (const id of ids.slice(0, -retainedViews))
      if (id !== currentRef.current && !active(next[id].phase)) delete next[id];
    viewsRef.current = next;
    setViews(next);
    setData((previous) =>
      previous
        ? {
            ...previous,
            conversations: [
              view,
              ...previous.conversations.filter((c) => c.id !== view.id),
            ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
          }
        : previous,
    );
  }, []);
  useEffect(() => {
    let alive = true;
    const visit = navigation.current;
    void refresh()
      .then(async (next) => {
        if (!alive || visit !== navigation.current) return;
        setSelection(next.settings.defaults);
        const last = next.settings.lastConversation;
        if (last && next.conversations.some((c) => c.id === last)) {
          await open(last, next.settings.defaults);
        }
      })
      .catch((error) => setError(String(error)));
    // Missed the base of an incremental event: read the full view once. Its
    // revision is the sequence the following incremental events build on.
    const resyncing = new Set<string>();
    const resync = (id: string, key: string) => {
      if (resyncing.has(key)) return;
      resyncing.add(key);
      void api
        .invoke("view", { id })
        .then((view) => {
          if (!alive) return;
          // A newer complete event (such as run_end) makes this view stale.
          if (
            view.runId &&
            `${id}/${view.runId}` === key &&
            (view.revision ?? 0) > (sequences.current.get(key) ?? 0)
          )
            sequences.current.set(key, view.revision!);
          acceptView(view);
        })
        .catch(() => {
          /* The run's final event carries the complete view. */
        })
        .finally(() => resyncing.delete(key));
    };
    const unsubscribe = api.onChat((event) => {
      // Global revisions belong to the whole app, independently of run sequences.
      globalUsage.current = newerGlobalUsage(
        globalUsage.current,
        event.globalUsage,
      );
      setData((previous) =>
        previous ? { ...previous, globalUsage: globalUsage.current } : previous,
      );
      if (deletedConversations.current.has(event.conversationId)) return;
      const latest = latestRuns.current.get(event.conversationId);
      if (latest && latest !== event.runId && event.type !== "run_start")
        return;
      latestRuns.current.set(event.conversationId, event.runId);
      const key = `${event.conversationId}/${event.runId}`;
      if ((sequences.current.get(key) ?? 0) >= event.sequence) return;
      let view = event.view;
      if (event.messagesFrom !== undefined) {
        const previous = viewsRef.current[event.conversationId];
        if (
          sequences.current.get(key) !== event.baseSequence ||
          !previous ||
          previous.messages.length < event.messagesFrom
        ) {
          resync(event.conversationId, key);
          return;
        }
        view = {
          ...view,
          messages: [
            ...previous.messages.slice(0, event.messagesFrom),
            ...view.messages,
          ],
        };
      }
      sequences.current.set(key, event.sequence);
      acceptView(view);
      if (
        event.type === "run_end" &&
        event.view.phase === "completed" &&
        !notifiedRuns.current.has(key)
      ) {
        notifiedRuns.current.add(key);
        if (visibleConversation.current !== event.conversationId) {
          setUnread((previous) => new Set(previous).add(event.conversationId));
        }
      }
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [refresh, acceptView]);
  useEffect(() => {
    const idle = requestIdleCallback(() => void loadSettingsPage());
    return () => cancelIdleCallback(idle);
  }, []);
  useEffect(() => {
    const preference = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () =>
      (document.documentElement.dataset.theme =
        data?.settings.theme === "system"
          ? preference.matches
            ? "dark"
            : "light"
          : (data?.settings.theme ?? "light"));
    apply();
    preference.addEventListener("change", apply);
    return () => preference.removeEventListener("change", apply);
  }, [data?.settings.theme]);
  async function open(id: string, defaults = data?.settings.defaults) {
    if (id === current) {
      if (!historyLoad && page === "chat") return;
      navigation.current++;
      setHistoryLoad(undefined);
      setPage("chat");
      return;
    }
    if (id === historyLoad?.id && !historyLoad.failed && page === "chat")
      return;
    const visit = ++navigation.current;
    visibleConversation.current = undefined;
    setReadyConversation(undefined);
    setPage("chat");
    setHistoryLoad({ id, failed: false });
    setHistoryStartedAt(performance.now());
    try {
      await afterPaint();
      if (visit !== navigation.current) return;
      const view = await api.invoke("open", { id });
      if (visit !== navigation.current) return;
      // History can render in the background; selection already painted above.
      startTransition(() => {
        acceptView(view);
        setCurrent(id);
        setSelection(view.selection ?? defaults);
        setText("");
        setDraftImages([]);
        setHistoryLoad(undefined);
      });
    } catch {
      if (visit !== navigation.current) return;
      setHistoryLoad({ id, failed: true });
    }
  }
  function newConversation() {
    navigation.current++;
    if (historyLoad && !current) {
      setHistoryLoad(undefined);
      setPage("chat");
      return;
    }
    setDraftId(crypto.randomUUID());
    setCurrent(undefined);
    setReadyConversation(undefined);
    setHistoryLoad(undefined);
    setHistoryStartedAt(undefined);
    setSelection(data?.settings.defaults);
    setText("");
    setDraftImages([]);
    setPage("chat");
  }
  async function deleteConversation(id: string) {
    if (deletionPending.current) return;
    deletionPending.current = true;
    setDeleting(true);
    try {
      await api.invoke("delete", { id });
      deletedConversations.current.add(id);
      setData((previous) =>
        previous
          ? {
              ...previous,
              conversations: previous.conversations.filter((c) => c.id !== id),
            }
          : previous,
      );
      const remaining = { ...viewsRef.current };
      delete remaining[id];
      viewsRef.current = remaining;
      setViews(remaining);
      setUnread((previous) => {
        const next = new Set(previous);
        next.delete(id);
        return next;
      });
      if (current === id || historyLoad?.id === id) newConversation();
      setDialog(undefined);
      // Refresh usage and settings without delaying the visible removal.
      void refresh().catch((error) => notifyError(String(error)));
    } catch (error) {
      notifyError(String(error));
    } finally {
      deletionPending.current = false;
      setDeleting(false);
    }
  }
  async function togglePin(id: string) {
    if (!data || pinSaving.current) return;
    pinSaving.current = true;
    setPinPending(true);
    try {
      const existing = (data.settings.pinnedConversationIds ?? []).filter(
        (pinnedId) =>
          data.conversations.some(
            (conversation) => conversation.id === pinnedId,
          ),
      );
      await settings({
        pinnedConversationIds: existing.includes(id)
          ? existing.filter((pinnedId) => pinnedId !== id)
          : [...existing, id],
      });
    } catch (error) {
      notifyError(String(error));
    } finally {
      pinSaving.current = false;
      setPinPending(false);
    }
  }
  async function settings(patch: Partial<Settings>) {
    // Show a theme at once instead of after the save round trip; restore the
    // previous one if saving fails.
    const theme = data?.settings.theme;
    const showTheme = (next?: Settings["theme"]) =>
      next &&
      setData((previous) =>
        previous
          ? { ...previous, settings: { ...previous.settings, theme: next } }
          : previous,
      );
    if (patch.theme) showTheme(patch.theme);
    let result: Settings;
    try {
      result = await api.invoke("settings", patch);
    } catch (error) {
      if (patch.theme) showTheme(theme);
      throw error;
    }
    if (patch.defaults && !current) setSelection(patch.defaults);
    setData((previous) =>
      previous ? { ...previous, settings: result } : previous,
    );
  }
  async function sendText(nextText: string, images: ChatImage[] = []) {
    if (!selection || (!nextText.trim() && !images.length) || sending || busy)
      throw new Error("消息不能为空");
    const submissionKey = current ?? draftId;
    if (submissionLocks.current.has(submissionKey))
      throw new Error("当前会话正在运行，请先停止");
    submissionLocks.current.add(submissionKey);
    setPendingSends((previous) => new Set(previous).add(submissionKey));
    const visit = navigation.current;
    setNotice(undefined);
    try {
      const view = await api.invoke("send", {
        conversationId: current,
        requestId: crypto.randomUUID(),
        text: nextText,
        images,
        selection,
      });
      acceptView(view);
      if (visit === navigation.current) {
        setCurrent(view.id);
        setText("");
        setDraftImages([]);
        // The prompt is already accepted. A settings failure must not restore
        // it as an unsent draft and invite a duplicate submission.
        void settings({ lastConversation: view.id }).catch((error) =>
          notifyError(String(error)),
        );
      }
    } catch (error) {
      notifyError(String(error));
      throw error;
    } finally {
      submissionLocks.current.delete(submissionKey);
      setPendingSends((previous) => {
        const next = new Set(previous);
        next.delete(submissionKey);
        return next;
      });
    }
  }
  async function mutateMessage(action: () => Promise<ConversationView>) {
    if (!current || busy || submissionLocks.current.has(current))
      throw new Error("当前会话正在运行，请先停止");
    const id = current;
    submissionLocks.current.add(id);
    setPendingSends((previous) => new Set(previous).add(id));
    try {
      acceptView(await action());
    } finally {
      submissionLocks.current.delete(id);
      setPendingSends((previous) => {
        const next = new Set(previous);
        next.delete(id);
        return next;
      });
    }
  }
  async function changeModel(next: Selection) {
    setSelection(next);
    void settings({ defaults: next }).catch(() => {});
    if (!current) return;
    try {
      const view = await api.invoke("model", { id: current, selection: next });
      acceptView(view);
    } catch (error) {
      notifyError(String(error));
    }
  }
  async function cancelCurrent() {
    if (!currentView?.runId) return;
    try {
      await api.invoke("cancel", {
        conversationId: currentView.id,
        runId: currentView.runId,
      });
    } catch (nextError) {
      notifyError(String(nextError));
    }
  }
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (deletionPending.current) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        newConversation();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
      if (event.key === "Escape") {
        setDialog(undefined);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  if (!data)
    return (
      <main className="loading">
        <BrandMark />
        <h1>WorkLens</h1>
        <p>
          {systemText(error, language) ||
            t("app.preparingYourWorkspacePlaceholder")}
        </p>
        {error && (
          <button onClick={() => location.reload()}>{t("app.reload")}</button>
        )}
      </main>
    );
  const availableModel = data.providers
    .find((p) => p.id === selection?.provider)
    ?.models.find((m) => m.id === selection?.model);
  const pinnedIds = new Set(data.settings.pinnedConversationIds ?? []);
  const groups = [
    {
      key: "pinned",
      label: t("app.pinned"),
      conversations: data.conversations.filter((c) => pinnedIds.has(c.id)),
    },
    {
      key: "recents",
      label: t("app.recents"),
      conversations: data.conversations.filter((c) => !pinnedIds.has(c.id)),
    },
  ];
  return (
    <div
      className="app-shell"
      data-sidebar-collapsed={sidebarCollapsed ? "true" : undefined}
      data-settings-open={
        page === "settings" && !(showRecovery && data.recoveries.length)
          ? "true"
          : undefined
      }
    >
      <Hint content={`${t("search.search")} (${isMac ? "⌘K" : "Ctrl K"})`}>
        <Button
          variant="ghost"
          size="icon"
          className="sidebar-search-button"
          aria-label={t("search.searchConversations")}
          aria-keyshortcuts={isMac ? "Meta+K" : "Control+K"}
          onClick={() => setSearchOpen(true)}
        >
          <Search aria-hidden="true" strokeWidth={1.7} />
        </Button>
      </Hint>
      <Hint
        content={
          sidebarCollapsed ? t("app.expandSidebar") : t("app.collapseSidebar")
        }
      >
        <Button
          variant="ghost"
          size="icon"
          className="sidebar-toggle"
          aria-label={
            sidebarCollapsed ? t("app.expandSidebar") : t("app.collapseSidebar")
          }
          aria-expanded={!sidebarCollapsed}
          aria-controls="conversation-sidebar"
          onClick={() => setSidebarCollapsed((value) => !value)}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="3" width="18" height="18" rx="5" />
            <path d="M9 4v16" />
          </svg>
        </Button>
      </Hint>
      <aside
        id="conversation-sidebar"
        className="sidebar"
        inert={sidebarCollapsed}
        aria-hidden={sidebarCollapsed}
      >
        {!sidebarCollapsed && page !== "settings" && (
          <BackgroundEffect settings={data.settings} />
        )}
        <div className="brand">
          <BrandMark />
          <span>WorkLens</span>
        </div>
        <Button
          variant="ghost"
          className="new-chat"
          onClick={newConversation}
          aria-keyshortcuts={isMac ? "Meta+N" : "Control+N"}
        >
          <Plus size={17} />
          {t("app.newChat")}
          <kbd aria-hidden="true">{isMac ? "⌘ N" : "Ctrl N"}</kbd>
        </Button>
        <nav aria-label={t("app.conversations")} className="conversation-list">
          {groups
            .filter(
              (group) =>
                group.key === "recents" || group.conversations.length > 0,
            )
            .map((group) => (
              <section
                key={group.key}
                className="conversation-group"
                aria-label={group.label}
              >
                <div className="section-label">{group.label}</div>
                {group.key === "recents" && !data.conversations.length && (
                  <p className="sidebar-empty">{t("app.noConversationsYet")}</p>
                )}
                {group.conversations.map((conversation) => (
                  <div
                    key={conversation.id}
                    className={`conversation-item ${selectedConversation === conversation.id ? "selected" : ""}`}
                  >
                    <OverflowHint content={conversation.title}>
                      <Button
                        variant="ghost"
                        aria-current={
                          selectedConversation === conversation.id
                            ? "page"
                            : undefined
                        }
                        aria-label={conversation.title}
                        className="conversation-open"
                        onClick={() => void open(conversation.id)}
                      >
                        <span className="conversation-title">
                          <HistoryTitle title={conversation.title} />
                        </span>
                      </Button>
                    </OverflowHint>
                    {active(conversation.phase) && (
                      <span
                        className="history-loading-ring"
                        aria-hidden="true"
                      />
                    )}
                    {unread.has(conversation.id) &&
                      !active(conversation.phase) && (
                        <span
                          className="conversation-unread"
                          role="img"
                          aria-label={t("app.unreadReply")}
                        />
                      )}
                    <div className="conversation-actions">
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={t("app.conversationOptions", {
                                title: conversation.title,
                              })}
                            />
                          }
                        >
                          <MoreHorizontal size={16} />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" side="right">
                          <DropdownMenuGroup>
                            <DropdownMenuItem
                              disabled={pinPending}
                              onClick={() => void togglePin(conversation.id)}
                            >
                              {pinnedIds.has(conversation.id) ? (
                                <PinOff />
                              ) : (
                                <Pin />
                              )}
                              {pinnedIds.has(conversation.id)
                                ? t("app.unpin")
                                : t("app.pin")}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() =>
                                setDialog({
                                  type: "rename",
                                  id: conversation.id,
                                  title: conversation.title,
                                })
                              }
                            >
                              <Pencil />
                              {t("app.rename")}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              variant="destructive"
                              onClick={() =>
                                setDialog({
                                  type: "delete",
                                  id: conversation.id,
                                  title: conversation.title,
                                })
                              }
                            >
                              <Trash2 />
                              {t("common.delete")}
                            </DropdownMenuItem>
                          </DropdownMenuGroup>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                ))}
              </section>
            ))}
        </nav>
        <div className="sidebar-bottom">
          <Button
            variant="ghost"
            className="sidebar-settings-button w-full justify-start"
            onClick={() => {
              setSettingsSection("general");
              setPage("settings");
            }}
          >
            <SettingsIcon />
            {t("app.settings")}
          </Button>
        </div>
      </aside>
      <main className="main-content">
        <>
          <header className="chat-header">
            <div>
              {currentConversation && (
                <Hint content={currentConversation.title}>
                  <h1
                    data-slot="chat-title"
                    tabIndex={0}
                    aria-label={currentConversation.title}
                  >
                    {shortTitle(currentConversation.title)}
                  </h1>
                </Hint>
              )}
            </div>
            {currentView && !loadingHistory && (
              <div className="chat-header-actions">
                <UsagePopover
                  global={data.globalUsage}
                  usage={currentView?.usage}
                  selection={currentView?.selection ?? selection}
                  providers={data.providers}
                  compacting={currentView?.phase === "compacting"}
                />
              </div>
            )}
          </header>
          {loadingHistory && (
            <div
              className="agent-thread relative"
              data-slot="conversation-loading"
              aria-busy={!loadingHistory.failed}
            >
              {loadingHistory.failed ? (
                <div className="mx-auto w-full max-w-[880px] px-6 py-6 md:px-10">
                  <p
                    role="alert"
                    className="text-muted-foreground mb-6 text-sm"
                  >
                    {t("thread.conversationLoadFailed")}
                  </p>
                  <Button
                    variant="outline"
                    onClick={() => void open(loadingHistory.id)}
                  >
                    {t("thread.retryLoad")}
                  </Button>
                </div>
              ) : (
                <ThreadLoadingIndicator startedAt={historyStartedAt} />
              )}
            </div>
          )}
          <div className={loadingHistory ? "hidden" : "contents"}>
            <AgentThread
              key={current ?? draftId}
              suspended={!!loadingHistory}
              onHistoryReady={markHistoryReady}
              historyStartedAt={historyStartedAt}
              view={currentView}
              onConsentChange={acceptView}
              canSend={!!availableModel?.available && !sending}
              submitting={sending}
              draft={text}
              draftImages={draftImages}
              supportsImages={!!availableModel?.image}
              onError={notifyError}
              onDraftLoaded={() => {
                setText("");
                setDraftImages([]);
              }}
              recoveredEdit={
                recoveredEdit?.conversationId === current
                  ? recoveredEdit
                  : undefined
              }
              onRecoveredEditLoaded={() => setRecoveredEdit(undefined)}
              onSend={sendText}
              onEdit={async (messageId, text, images) => {
                if (!current || !selection || !currentView?.branchId)
                  throw new Error("MESSAGE_VERSION_MISSING");
                const input = {
                  conversationId: current,
                  messageId,
                  expectedBranchId: currentView.branchId,
                  requestId: crypto.randomUUID(),
                  text,
                  images,
                  selection,
                };
                await mutateMessage(() => api.invoke("editMessage", input));
              }}
              onSelectVersion={async (messageId, targetId) => {
                if (!current || !currentView?.branchId)
                  throw new Error("MESSAGE_VERSION_MISSING");
                const input = {
                  conversationId: current,
                  messageId,
                  targetId,
                  expectedBranchId: currentView.branchId,
                };
                await mutateMessage(() =>
                  api.invoke("selectMessageVersion", input),
                );
              }}
              onCancel={cancelCurrent}
              onOpenProviderSettings={() => {
                setSettingsSection("providers");
                setPage("settings");
              }}
              onNewConversation={newConversation}
              modelMenu={{
                data,
                selection,
                onChange: changeModel,
                onManage: () => {
                  setPage("settings");
                  setSettingsSection(
                    data.providers.some((p) => p.configured)
                      ? "models"
                      : "providers",
                  );
                },
              }}
            />
          </div>
        </>
      </main>
      <ConversationSearch
        open={searchOpen}
        onOpenChange={setSearchOpen}
        recents={data.conversations}
        onSelect={(selection) => {
          setSearchOpen(false);
          clearSearchHighlight();
          const { query } = selection;
          setReveal(query ? { ...selection, query } : undefined);
          void open(selection.id);
        }}
      />
      <Dialog
        open={page === "settings" && !(showRecovery && data.recoveries.length)}
        onOpenChange={(open) => {
          if (!open) setPage("chat");
        }}
      >
        <DialogContent
          className="settings-shell-dialog"
          overlayClassName="settings-backdrop"
          showCloseButton={false}
          aria-describedby={undefined}
        >
          <DialogTitle className="sr-only">{t("app.settings")}</DialogTitle>
          {page === "settings" && (
            <Suspense fallback={null}>
              <SettingsPage
                data={data}
                conversation={currentView}
                onConsentChange={acceptView}
                initialSection={settingsSection}
                save={settings}
                onMcpChange={(mcp) =>
                  setData((current) =>
                    current ? { ...current, mcp } : current,
                  )
                }
                refresh={refresh}
                onBack={() => setPage("chat")}
                onError={notifyError}
                onSuccess={notifySuccess}
              />
            </Suspense>
          )}
        </DialogContent>
      </Dialog>
      {showRecovery && data.recoveries.length > 0 && (
        <Modal
          title={t("app.anEarlierTaskWasInterrupted")}
          onClose={() => setShowRecovery(false)}
        >
          <p>{t("app.recoveryDescription")}</p>
          {data.recoveries.map((item) => (
            <div className="recovery-item" key={item.runId}>
              <p>{item.text.slice(0, 180)}</p>
              {!!item.imageCount && (
                <p>
                  {t("attachments.recoveryCount", { count: item.imageCount })}
                </p>
              )}
              <div className="actions">
                <button
                  onClick={() => {
                    const visit = navigation.current;
                    void (async () => {
                      const images = item.imageCount
                        ? await api.invoke("recoveryImages", {
                            runId: item.runId,
                          })
                        : [];
                      if (visit !== navigation.current) return;
                      if (
                        data.conversations.some(
                          (c) => c.id === item.conversationId,
                        )
                      ) {
                        let view = await api.invoke("open", {
                          id: item.conversationId,
                        });
                        if (visit !== navigation.current) return;
                        if (item.editOf) {
                          if (!view.branchId)
                            throw new Error("MESSAGE_VERSION_MISSING");
                          view = await api.invoke("recoverMessageEdit", {
                            runId: item.runId,
                            expectedBranchId: view.branchId,
                          });
                          if (visit !== navigation.current) return;
                          setRecoveredEdit({
                            conversationId: view.id,
                            messageId: item.editOf,
                            text: item.text,
                            images,
                            runId: item.runId,
                          });
                        }
                        navigation.current++;
                        acceptView(view);
                        setCurrent(view.id);
                      } else {
                        if (item.editOf)
                          throw new Error("MESSAGE_VERSION_MISSING");
                        newConversation();
                      }
                      if (!item.editOf) {
                        setText(item.text);
                        setDraftImages(images);
                      }
                      setSelection(item.selection);
                      setPage("chat");
                      setShowRecovery(false);
                    })().catch((error) => notifyError(String(error)));
                  }}
                >
                  {t("app.loadDraftForReview")}
                </button>
                <button
                  className="danger"
                  onClick={() =>
                    void api
                      .invoke("dismissRecovery", { runId: item.runId })
                      .then(refresh)
                      .catch((e) => notifyError(String(e)))
                  }
                >
                  {t("app.dismissRecoveryRecord")}
                </button>
              </div>
            </div>
          ))}
        </Modal>
      )}
      {dialog && (
        <ConversationDialog
          title={
            dialog.type === "delete"
              ? t("app.deleteConversationQuestion")
              : t("app.renameConversation")
          }
          onClose={() => {
            if (!deletionPending.current) setDialog(undefined);
          }}
        >
          {dialog.type === "delete" ? (
            <DialogDescription className="text-sm leading-6">
              {t("app.deleteConversationDescription")}
            </DialogDescription>
          ) : (
            <div className="space-y-2">
              <Input
                aria-label={t("app.conversationName")}
                aria-describedby="rename-count"
                autoFocus
                value={dialog.title}
                onChange={(e) =>
                  setDialog({
                    ...dialog,
                    title: (e.nativeEvent as InputEvent).isComposing
                      ? e.target.value
                      : titleCharacters(e.target.value)
                          .slice(0, RENAME_LIMIT)
                          .join(""),
                  })
                }
                onCompositionEnd={(e) =>
                  setDialog({
                    ...dialog,
                    title: titleCharacters(e.currentTarget.value)
                      .slice(0, RENAME_LIMIT)
                      .join(""),
                  })
                }
              />
              <p
                id="rename-count"
                className="text-right text-xs text-muted-foreground"
                aria-live="polite"
              >
                {titleCharacters(dialog.title).length}/{RENAME_LIMIT}
              </p>
            </div>
          )}
          <div className="mt-1 flex justify-end gap-2">
            <Button
              variant="outline"
              autoFocus={dialog.type === "delete"}
              disabled={deleting}
              onClick={() => setDialog(undefined)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              className={
                dialog.type === "delete"
                  ? "bg-destructive text-white hover:bg-destructive/90 focus-visible:border-destructive focus-visible:ring-destructive/30"
                  : undefined
              }
              disabled={
                deleting ||
                !dialog.title.trim() ||
                (dialog.type === "rename" &&
                  titleCharacters(dialog.title).length > RENAME_LIMIT)
              }
              aria-busy={deleting}
              onClick={() =>
                dialog.type === "delete"
                  ? void deleteConversation(dialog.id)
                  : void api
                      .invoke("rename", {
                        id: dialog.id,
                        title: dialog.title,
                      })
                      .then(async () => {
                        if (current === dialog.id) await open(dialog.id);
                        setDialog(undefined);
                        await refresh();
                      })
                      .catch((e) => notifyError(String(e)))
              }
            >
              {deleting && (
                <LoaderCircle
                  aria-hidden="true"
                  className="motion-safe:animate-spin"
                />
              )}
              <span aria-live="polite">
                {deleting
                  ? t("app.deletingConversation")
                  : dialog.type === "delete"
                    ? t("common.delete")
                    : t("app.saveName")}
              </span>
            </Button>
          </div>
        </ConversationDialog>
      )}
    </div>
  );
}

function ConversationDialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="gap-5 p-6 sm:max-w-[440px]"
      >
        <DialogTitle className="text-lg leading-7 font-normal">
          {title}
        </DialogTitle>
        {children}
      </DialogContent>
    </Dialog>
  );
}

function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  const { t } = useAppTranslation();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} className="modal" aria-label={title} onCancel={onClose}>
      <div className="modal-heading">
        <h2>{title}</h2>
        <button
          className="icon"
          aria-label={t("app.closeDialog")}
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
