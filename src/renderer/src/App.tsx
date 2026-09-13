import { BrandMark } from "@/components/worklens/BrandMark";
import { HistoryTitle } from "@/components/worklens/HistoryTitle";
import { Input } from "@/components/ui/input";
import { Hint, OverflowHint } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Plus,
  MoreHorizontal,
  Settings as SettingsIcon,
  X,
  Trash2,
  Pencil,
  Pin,
  PinOff,
} from "lucide-react";
import {
  SettingsPage,
  type SettingsSection,
} from "@/components/worklens/SettingsPage";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { systemText } from "@/lib/system-text";
import { useLocale } from "@/lib/locale";
import { UsagePopover } from "@/components/worklens/UsagePopover";
import { newerGlobalUsage } from "../../shared/usage";
import { AgentThread } from "@/components/worklens/AgentThread";
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
const active = (phase?: Phase) =>
  !!phase &&
  ["generating", "tool", "compacting", "retrying", "stopping"].includes(phase);
export function App() {
  const { t, language } = useLocale();
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>("general");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem("worklens.sidebarCollapsed") === "true"; }
    catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("worklens.sidebarCollapsed", String(sidebarCollapsed)); }
    catch { /* Keep the toggle usable when storage is unavailable. */ }
  }, [sidebarCollapsed]);
  const [data, setData] = useState<Bootstrap>();
  const [views, setViews] = useState<Record<string, ConversationView>>({});
  const [current, setCurrent] = useState<string>();
  const [page, setPage] = useState<"chat" | "settings">("chat");
  const pinSaving = useRef(false);
  const [pinPending, setPinPending] = useState(false);
  const [unread, setUnread] = useState<Set<string>>(() => new Set());
  const visibleConversation = useRef<string | undefined>(undefined);
  const notifiedRuns = useRef(new Set<string>());
  useEffect(() => {
    visibleConversation.current = page === "chat" ? current : undefined;
    if (page === "chat" && current) setUnread(previous => {
      if (!previous.has(current)) return previous;
      const next = new Set(previous);
      next.delete(current);
      return next;
    });
  }, [current, page]);
  const [selection, setSelection] = useState<Selection>();
  const [text, setText] = useState("");
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
    const isModelSwitchReminder = notice.type === "error" &&
      systemText(notice.text.replace(/^Error: /, ""), "en") === "Can’t switch models while responding.";
    const needsSettings =
      notice.type === "error" && /模型尚未配置|模型.*不可用/.test(notice.text);
    let disposed = false;
    const id = toast.add({
      title: needsSettings
        ? t(
            "Connect a provider to start chatting.",
            "请先选择并连接一个可用模型。",
          )
        : systemText(notice.text.replace(/^Error: /, ""), language),
      onClose: () => {
        if (!disposed)
          setNotice((current) => (current === notice ? undefined : current));
      },
      type: isModelSwitchReminder ? "info" : notice.type,
      timeout: notice.type === "error" ? 0 : 3200,
      priority: notice.type === "error" ? "high" : "low",
      actionProps: needsSettings
        ? {
            children: t("Open settings", "前往设置"),
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
  }, [notice, language, t]);
  const [pendingSends, setPendingSends] = useState(new Set<string>());
  const [draftId, setDraftId] = useState(() => crypto.randomUUID());
  const navigation = useRef(0);
  const submissionLocks = useRef(new Set<string>());
  const [dialog, setDialog] = useState<{
    type: "delete" | "rename";
    id: string;
    title: string;
  }>();
  const [showRecovery, setShowRecovery] = useState(true);
  const sequences = useRef(new Map<string, number>());
  const latestRuns = useRef(new Map<string, string>());
  const globalUsage = useRef<GlobalUsage | undefined>(undefined);
  const currentView = current ? views[current] : undefined;
  const busy = active(currentView?.phase);
  const sending = pendingSends.has(current ?? draftId);
  const refresh = useCallback(async () => {
    const next = await api.invoke("bootstrap", undefined);
    globalUsage.current = newerGlobalUsage(
      globalUsage.current,
      next.globalUsage,
    );
    setData({ ...next, globalUsage: globalUsage.current });
    return next;
  }, []);
  const acceptView = useCallback((view: ConversationView) => {
    if (
      view.runId &&
      (sequences.current.get(`${view.id}/${view.runId}`) ?? 0) >
        (view.revision ?? 0)
    )
      return;
    setViews((previous) => ({ ...previous, [view.id]: view }));
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
    void refresh()
      .then(async (next) => {
        if (!alive) return;
        setSelection(next.settings.defaults);
        const last = next.settings.lastConversation;
        if (last && next.conversations.some((c) => c.id === last)) {
          const view = await api.invoke("open", { id: last });
          if (alive) {
            acceptView(view);
            setCurrent(last);
            setSelection(view.selection ?? next.settings.defaults);
          }
        }
      })
      .catch((error) => setError(String(error)));
    const unsubscribe = api.onChat((event) => {
      // Global revisions belong to the whole app, independently of run sequences.
      globalUsage.current = newerGlobalUsage(
        globalUsage.current,
        event.globalUsage,
      );
      setData((previous) =>
        previous ? { ...previous, globalUsage: globalUsage.current } : previous,
      );
      const latest = latestRuns.current.get(event.conversationId);
      if (latest && latest !== event.runId && event.type !== "run_start")
        return;
      latestRuns.current.set(event.conversationId, event.runId);
      const key = `${event.conversationId}/${event.runId}`;
      if ((sequences.current.get(key) ?? 0) >= event.sequence) return;
      sequences.current.set(key, event.sequence);
      acceptView(event.view);
      if (event.type === "run_end" && event.view.phase === "completed" && !notifiedRuns.current.has(key)) {
        notifiedRuns.current.add(key);
        if (visibleConversation.current !== event.conversationId) {
          setUnread(previous => new Set(previous).add(event.conversationId));
        }
      }
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [refresh, acceptView]);
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
  async function open(id: string) {
    const visit = ++navigation.current;
    try {
      const view = await api.invoke("open", { id });
      acceptView(view);
      if (visit !== navigation.current) return;
      setCurrent(id);
      setSelection(view.selection ?? data?.settings.defaults);
      setPage("chat");
      setText("");
    } catch (error) {
      notifyError(String(error));
    }
  }
  function newConversation() {
    navigation.current++;
    setDraftId(crypto.randomUUID());
    setCurrent(undefined);
    setSelection(data?.settings.defaults);
    setText("");
    setPage("chat");
  }
  async function togglePin(id: string) {
    if (!data || pinSaving.current) return;
    pinSaving.current = true;
    setPinPending(true);
    try {
      const existing = (data.settings.pinnedConversationIds ?? []).filter(
        pinnedId => data.conversations.some(conversation => conversation.id === pinnedId),
      );
      await settings({ pinnedConversationIds: existing.includes(id)
        ? existing.filter(pinnedId => pinnedId !== id)
        : [...existing, id] });
    } catch (error) {
      notifyError(String(error));
    } finally {
      pinSaving.current = false;
      setPinPending(false);
    }
  }
  async function settings(patch: Partial<Settings>) {
    const result = await api.invoke("settings", patch);
    if (patch.defaults && !current) setSelection(patch.defaults);
    setData((previous) =>
      previous ? { ...previous, settings: result } : previous,
    );
  }
  async function sendText(nextText: string) {
    if (!selection || !nextText.trim() || sending || busy) return;
    const submissionKey = current ?? draftId;
    if (submissionLocks.current.has(submissionKey)) return;
    submissionLocks.current.add(submissionKey);
    setPendingSends((previous) => new Set(previous).add(submissionKey));
    const visit = navigation.current;
    setNotice(undefined);
    try {
      const view = await api.invoke("send", {
        conversationId: current,
        requestId: crypto.randomUUID(),
        text: nextText,
        selection,
      });
      acceptView(view);
      if (visit === navigation.current) {
        setCurrent(view.id);
        setText("");
        await settings({ lastConversation: view.id });
      }
    } catch (error) {
      notifyError(String(error));
    } finally {
      submissionLocks.current.delete(submissionKey);
      setPendingSends((previous) => {
        const next = new Set(previous);
        next.delete(submissionKey);
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
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        newConversation();
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
            t("Preparing your workspace…", "正在准备你的本地工作助手…")}
        </p>
        {error && (
          <button onClick={() => location.reload()}>
            {t("Reload", "重新加载")}
          </button>
        )}
      </main>
    );
  const availableModel = data.providers
    .find((p) => p.id === selection?.provider)
    ?.models.find((m) => m.id === selection?.model);
  const pinnedIds = new Set(data.settings.pinnedConversationIds ?? []);
  const groups = [
    { key: "pinned", label: t("Pinned", "置顶"), conversations: data.conversations.filter(c => pinnedIds.has(c.id)) },
    { key: "recents", label: t("Recents", "最近会话"), conversations: data.conversations.filter(c => !pinnedIds.has(c.id)) },
  ];
  return (
    <div className="app-shell" data-sidebar-collapsed={sidebarCollapsed ? "true" : undefined} data-settings-open={page === "settings" && !(showRecovery && data.recoveries.length) ? "true" : undefined}>
      <Hint content={sidebarCollapsed ? t("Expand sidebar", "展开侧栏") : t("Collapse sidebar", "折叠侧栏")}>
      <Button
        variant="ghost"
        size="icon"
        className="sidebar-toggle"
        aria-label={sidebarCollapsed ? t("Expand sidebar", "展开侧栏") : t("Collapse sidebar", "折叠侧栏")}
        aria-expanded={!sidebarCollapsed}
        aria-controls="conversation-sidebar"
        onClick={() => setSidebarCollapsed(value => !value)}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="5" />
          <path d="M9 4v16" />
        </svg>
      </Button>
      </Hint>
      <aside id="conversation-sidebar" className="sidebar" inert={sidebarCollapsed} aria-hidden={sidebarCollapsed}>
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
          {t("New chat", "新建会话")}
          <kbd aria-hidden="true">{isMac ? "⌘ N" : "Ctrl N"}</kbd>
        </Button>
        <nav
          aria-label={t("Conversations", "会话列表")}
          className="conversation-list"
        >
          {groups.filter(group => group.key === "recents" || group.conversations.length > 0).map(group => (
            <section key={group.key} className="conversation-group" aria-label={group.label}>
              <div className="section-label">{group.label}</div>
              {group.key === "recents" && !data.conversations.length && (
                <p className="sidebar-empty">{t("No conversations yet", "暂无历史会话")}</p>
              )}
              {group.conversations.map((conversation) => (
            <div
              key={conversation.id}
              className={`conversation-item ${current === conversation.id ? "selected" : ""}`}
            >
              <OverflowHint content={conversation.title}><Button
                variant="ghost"
                aria-current={current === conversation.id ? "page" : undefined}

                className="conversation-open"
                onClick={() => void open(conversation.id)}
              >
                <span className="conversation-title">
                  <HistoryTitle title={conversation.title} />
                </span>
              </Button></OverflowHint>
              {active(conversation.phase) && (
                <span className="history-loading-ring" aria-hidden="true" />
              )}
              {unread.has(conversation.id) && !active(conversation.phase) && (
                <span className="conversation-unread" role="img" aria-label={t("Unread reply", "未读回复")} />
              )}
              <div className="conversation-actions">
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={
                          t("Conversation options: ", "会话选项：") +
                          conversation.title
                        }
                      />
                    }
                  >
                    <MoreHorizontal size={16} />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" side="right">
                    <DropdownMenuGroup>
                      <DropdownMenuItem disabled={pinPending} onClick={() => void togglePin(conversation.id)}>
                        {pinnedIds.has(conversation.id) ? <PinOff /> : <Pin />}
                        {pinnedIds.has(conversation.id) ? t("Unpin", "取消置顶") : t("Pin", "置顶")}
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
                        {t("Rename", "重命名")}
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
                        {t("Delete", "删除")}
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
            {t("Settings", "设置")}
          </Button>
        </div>
      </aside>
      <main className="main-content">
        <>
          <header className="chat-header">
            <div>
              {currentView && <h1 data-slot="chat-title">{currentView.title}</h1>}
            </div>
            {currentView && <div className="chat-header-actions">
              <UsagePopover
                global={data.globalUsage}
                usage={currentView?.usage}
                selection={currentView?.selection ?? selection}
                providers={data.providers}
              />
            </div>}
          </header>
          <AgentThread
            key={current ?? draftId}
            view={currentView}
            canSend={!!availableModel?.available && !sending}
            draft={text}
            onDraftLoaded={() => setText("")}
            onSend={sendText}
            onCancel={cancelCurrent}
            modelMenu={{
              data,
              selection,
              onChange: changeModel,
              onManage: () => {
                setPage("settings");
                setSettingsSection(
                  data.providers.some((p) => p.configured) ? "models" : "providers",
                );
              },
            }}
          />
        </>
      </main>
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
          <DialogTitle className="sr-only">{t("Settings", "设置")}</DialogTitle>
          {page === "settings" && (
            <SettingsPage
              data={data}
              initialSection={settingsSection}
              save={settings}
              refresh={refresh}
              onBack={() => setPage("chat")}
              onError={notifyError}
              onSuccess={notifySuccess}
            />
          )}
        </DialogContent>
      </Dialog>
      {showRecovery && data.recoveries.length > 0 && (
        <Modal
          title={t("An earlier task was interrupted", "上次有任务意外中断")}
          onClose={() => setShowRecovery(false)}
        >
          <p>
            {t(
              "History and completed tool results are preserved. Review any changes before continuing; interrupted tasks do not restart automatically.",
              "历史与工具结果已保留。请核对工具产生的更改后再继续；中断任务不会自动重新执行。",
            )}
          </p>
          {data.recoveries.map((item) => (
            <div className="recovery-item" key={item.runId}>
              <p>{item.text.slice(0, 180)}</p>
              <div className="actions">
                <button
                  onClick={() =>
                    void (
                      data.conversations.some(
                        (c) => c.id === item.conversationId,
                      )
                        ? open(item.conversationId)
                        : Promise.resolve(newConversation())
                    ).then(() => {
                      setText(item.text);
                      setSelection(item.selection);
                      setPage("chat");
                      setShowRecovery(false);
                    })
                  }
                >
                  {t("Load draft for review", "载入草稿，核对后继续")}
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
                  {t("Dismiss recovery record", "已核对，清除此恢复记录")}
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
              ? t("Delete conversation?", "删除会话？")
              : t("Rename conversation", "重命名会话")
          }
          onClose={() => setDialog(undefined)}
        >
          {dialog.type === "delete" ? (
            <DialogDescription className="text-base leading-7 wrap-anywhere">
              <span className="text-foreground">
                {t("This will permanently delete ", "将永久删除会话 ")}
                <strong className="font-semibold">{dialog.title}</strong>
                {t(".", "。")}
              </span>
              <span className="mt-2 block text-sm leading-6 text-muted-foreground/80">{t("Running tasks will stop. Local files will be kept.", "运行中的任务会停止，本地文件会保留。")}</span>
            </DialogDescription>
          ) : (
            <Input
              aria-label={t("Conversation name", "会话名称")}
              autoFocus
              value={dialog.title}
              maxLength={120}
              onChange={(e) => setDialog({ ...dialog, title: e.target.value })}
            />
          )}
          <div className="mt-1 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDialog(undefined)}>
              {t("Cancel", "取消")}
            </Button>
            <Button
              className={dialog.type === "delete" ? "bg-destructive text-white hover:bg-destructive/90 focus-visible:border-destructive focus-visible:ring-destructive/30" : undefined}
              disabled={!dialog.title.trim()}
              onClick={() =>
                void (
                  dialog.type === "delete"
                    ? api.invoke("delete", { id: dialog.id })
                    : api.invoke("rename", {
                        id: dialog.id,
                        title: dialog.title,
                      })
                )
                  .then(async () => {
                    if (dialog.type === "delete" && current === dialog.id)
                      newConversation();
                    if (dialog.type === "rename" && current === dialog.id)
                      await open(dialog.id);
                    setDialog(undefined);
                    await refresh();
                  })
                  .catch((e) => notifyError(String(e)))
              }
            >
              {dialog.type === "delete"
                ? t("Delete", "删除")
                : t("Save name", "保存名称")}
            </Button>
          </div>
        </ConversationDialog>
      )}
    </div>
  );
}

function ConversationDialog({ title, children, onClose }: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent showCloseButton={false} className="gap-5 p-6 sm:max-w-[440px]">
        <DialogTitle className="text-lg leading-7 font-normal">{title}</DialogTitle>
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
  const { t } = useLocale();
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
          aria-label={t("Close dialog", "关闭对话框")}
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
