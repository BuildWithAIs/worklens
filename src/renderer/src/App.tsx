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
  LoaderCircle,
} from "lucide-react";
import {
  SettingsPage,
  type SettingsSection,
} from "@/components/worklens/SettingsPage";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { systemText } from "@/lib/system-text";
import { useLocale } from "@/lib/locale";
import { AgentThread } from "@/components/worklens/AgentThread";
import type {
  Bootstrap,
  ConversationView,
  Phase,
  Selection,
  Settings,
} from "../../shared/contracts";

const api = window.worklens;
const isMac = /Mac/i.test(navigator.platform);
const labels: Record<Phase, [string, string]> = {
  idle: ["Ready", "就绪"],
  generating: ["Generating", "正在生成"],
  tool: ["Running tool", "正在执行工具"],
  compacting: ["Compacting context", "正在压缩上下文"],
  retrying: ["Retrying", "等待重试"],
  stopping: ["Stopping", "正在停止"],
  completed: ["Completed", "已完成"],
  cancelled: ["Cancelled", "已取消"],
  failed: ["Failed", "运行失败"],
};
const active = (phase?: Phase) =>
  !!phase &&
  ["generating", "tool", "compacting", "retrying", "stopping"].includes(phase);
export function App() {
  const { t, language } = useLocale();
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>("providers");
  const [data, setData] = useState<Bootstrap>();
  const [views, setViews] = useState<Record<string, ConversationView>>({});
  const [current, setCurrent] = useState<string>();
  const [page, setPage] = useState<"chat" | "settings">("chat");
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
      type: notice.type,
      timeout: notice.type === "error" ? 0 : 3200,
      priority: notice.type === "error" ? "high" : "low",
      actionProps: needsSettings
        ? {
            children: t("Open settings", "前往设置"),
            onClick: () => {
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
  const currentView = current ? views[current] : undefined;
  const busy = active(currentView?.phase);
  const sending = pendingSends.has(current ?? draftId);
  const refresh = useCallback(async () => {
    const next = await api.invoke("bootstrap", undefined);
    setData(next);
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
        if (!next.providers.some((p) => p.models.some((m) => m.available)))
          setPage("settings");
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
      const latest = latestRuns.current.get(event.conversationId);
      if (latest && latest !== event.runId && event.type !== "run_start")
        return;
      latestRuns.current.set(event.conversationId, event.runId);
      const key = `${event.conversationId}/${event.runId}`;
      if ((sequences.current.get(key) ?? 0) >= event.sequence) return;
      sequences.current.set(key, event.sequence);
      acceptView(event.view);
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
        <div className="brand-mark">W</div>
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
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">W</div>
          <span>
            WorkLens
            <small>{t("Your local workspace", "你的本地工作助手")}</small>
          </span>
        </div>
        <Button
          variant="outline"
          className="new-chat"
          onClick={newConversation}
          aria-keyshortcuts={isMac ? "Meta+N" : "Control+N"}
        >
          <Plus size={17} />
          {t("New chat", "新建会话")}
          <kbd aria-hidden="true">{isMac ? "⌘ N" : "Ctrl N"}</kbd>
        </Button>
        <div className="section-label">
          {t("History", "历史会话")}{" "}
          <span>{data.conversations.length || ""}</span>
        </div>
        <nav
          aria-label={t("Conversations", "会话列表")}
          className="conversation-list"
        >
          {!data.conversations.length && (
            <p className="sidebar-empty">
              {t("No conversations yet", "暂无历史会话")}
            </p>
          )}
          {data.conversations.map((conversation) => (
            <div
              key={conversation.id}
              className={`conversation-item ${current === conversation.id ? "selected" : ""}`}
            >
              <Button
                variant="ghost"
                aria-current={current === conversation.id ? "page" : undefined}
                title={conversation.title}
                className="conversation-open"
                onClick={() => void open(conversation.id)}
              >
                <span className="conversation-title">
                  {active(conversation.phase) && (
                    <LoaderCircle size={13} className="spin" />
                  )}
                  <span className="truncate">{conversation.title}</span>
                </span>
              </Button>
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
                      <DropdownMenuItem
                        onClick={() =>
                          setDialog({
                            type: "rename",
                            id: conversation.id,
                            title: conversation.title,
                          })
                        }
                      >
                        <Pencil size={14} />
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
                        <Trash2 size={14} />
                        {t("Delete", "删除")}
                      </DropdownMenuItem>
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <Button
            variant="ghost"
            className="w-full justify-start"
            onClick={() => setPage("settings")}
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
              <h1>{currentView?.title ?? t("New conversation", "新的开始")}</h1>
            </div>
            {currentView && busy && (
              <span
                role="status"
                className={busy ? "run-status running" : "run-status"}
              >
                {busy && <LoaderCircle className="spin" size={13} />}{" "}
                {currentView.statusDetail
                  ? systemText(currentView.statusDetail, language)
                  : t(...labels[currentView.phase])}
              </span>
            )}
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
                setSettingsSection("models");
              },
            }}
          />
        </>
      </main>
      <Dialog
        open={page === "settings"}
        onOpenChange={(open) => {
          if (!open) setPage("chat");
        }}
      >
        <DialogContent
          className="settings-shell-dialog"
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
          compact={dialog.type === "delete"}
          title={
            dialog.type === "delete"
              ? t("Delete conversation?", "删除会话？")
              : t("Rename conversation", "重命名会话")
          }
          onClose={() => setDialog(undefined)}
        >
          {dialog.type === "delete" ? (
            <DialogDescription className="leading-6 wrap-anywhere">
              <span className="text-foreground">
                {t("This will permanently delete ", "将永久删除会话 ")}
                <strong className="font-semibold">{dialog.title}</strong>{t(".", "。")}
              </span>
              <span className="mt-2 block text-xs leading-5">{t("Running tasks will stop. Local files will be kept.", "运行中的任务会停止，本地文件会保留。")}</span>
            </DialogDescription>
          ) : (
            <input
              aria-label={t("Conversation name", "会话名称")}
              autoFocus
              value={dialog.title}
              maxLength={120}
              onChange={(e) => setDialog({ ...dialog, title: e.target.value })}
            />
          )}
          <div className={dialog.type === "delete" ? "mt-1 flex justify-end gap-2" : "actions"}>
            <Button variant="outline" onClick={() => setDialog(undefined)}>
              {t("Cancel", "取消")}
            </Button>
            <Button
              className={dialog.type === "delete" ? "bg-red-600 text-white hover:bg-red-700 focus-visible:border-red-500 focus-visible:ring-red-500/30" : undefined}
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

function ConversationDialog({ compact, title, children, onClose }: {
  compact: boolean;
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  if (!compact) return <Modal title={title} onClose={onClose}>{children}</Modal>;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent showCloseButton={false} className="p-5 sm:max-w-[400px]">
        <DialogTitle>{title}</DialogTitle>
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
