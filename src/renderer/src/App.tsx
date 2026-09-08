import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  UserRound,
  Square,
  Plus,
  Settings as SettingsIcon,
  ArrowLeft,
  ChevronDown,
  Check,
  Copy,
  Terminal,
  X,
  Trash2,
  Pencil,
  ShieldAlert,
  Cpu,
  CheckCircle2,
  LoaderCircle,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type {
  AuthStep,
  Bootstrap,
  ConversationView,
  MessageView,
  Phase,
  Selection,
  Settings,
} from "../../shared/contracts";

const api = window.worklens;
const labels: Record<Phase, string> = {
  idle: "就绪",
  generating: "正在生成",
  tool: "正在执行工具",
  compacting: "正在压缩上下文",
  retrying: "等待重试",
  stopping: "正在停止",
  completed: "已完成",
  cancelled: "已取消",
  failed: "运行失败",
};
const active = (phase?: Phase) =>
  !!phase &&
  ["generating", "tool", "compacting", "retrying", "stopping"].includes(phase);
const thinkingLabels: Record<string, string> = {
  off: "关闭",
  minimal: "最少",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
};

function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={{
        a: ({ href, children }) => (
          <a
            href={href}
            onClick={(event) => {
              event.preventDefault();
              if (href)
                void api.invoke("external", { url: href }).catch(() => {});
            }}
          >
            {children}
          </a>
        ),
        img: ({ alt }) => <span>[图片：{alt}]</span>,
        pre: ({ children }) => (
          <div className="code">
            <button
              className="icon copy-code"
              title="复制代码"
              onClick={(event) =>
                void navigator.clipboard.writeText(
                  event.currentTarget.parentElement?.querySelector("pre")
                    ?.textContent ?? "",
                )
              }
            >
              <Copy size={14} />
            </button>
            <pre>{children}</pre>
          </div>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
const Message = memo(function Message({ message }: { message: MessageView }) {
  if (message.role === "summary")
    return (
      <details className="summary">
        <summary>上下文已压缩 · 查看摘要</summary>
        <Markdown text={message.text} />
      </details>
    );
  if (message.role === "tool")
    return (
      <details className={`tool-card ${message.status}`}>
        <summary>
          <Terminal size={16} />
          <strong>{message.toolName}</strong>
          <span className="tool-arg">
            {message.args?.replace(/\s+/g, " ").slice(0, 95)}
          </span>
          <span className="tool-status">
            {
              {
                pending: "待执行",
                waiting: "等待资源",
                running: "执行中",
                success: "成功",
                error: "失败",
                timeout: "已超时",
                cancelled: "已取消",
              }[message.status ?? "pending"]
            }
            {message.elapsed !== undefined && message.status !== "running"
              ? ` · ${(message.elapsed / 1000).toFixed(1)}s`
              : ""}
          </span>
          <ChevronDown size={14} />
        </summary>
        <div className="tool-detail">
          {message.shellCwd && (
            <>
              <label>命令初始目录</label>
              <pre>{message.shellCwd}</pre>
              <p className="subtle">
                超时：
                {message.timeoutSeconds === undefined
                  ? "未设置"
                  : `${message.timeoutSeconds} 秒`}
                {message.exitCode !== undefined
                  ? ` · 退出码：${message.exitCode === null ? "进程被终止" : message.exitCode}`
                  : ""}
              </p>
            </>
          )}
          {message.targetPath && (
            <>
              <label>目标绝对路径</label>
              <pre>{message.targetPath}</pre>
            </>
          )}
          {message.startedAt && (
            <p className="subtle">
              开始时间：{new Date(message.startedAt).toLocaleString("zh-CN")}
              {message.elapsed !== undefined
                ? ` · 耗时 ${(message.elapsed / 1000).toFixed(2)} 秒`
                : ""}
            </p>
          )}
          <label>参数</label>
          <pre>{message.args}</pre>
          {message.text && (
            <>
              <label>结果</label>
              <pre>{message.text}</pre>
            </>
          )}
        </div>
      </details>
    );
  return (
    <article className={`message ${message.role}`}>
      <div className="message-by">
        {message.role === "user" ? (
          <span
            className="user-avatar"
            role="img"
            aria-label="你的头像"
            title="你"
          >
            <UserRound size={18} aria-hidden="true" />
          </span>
        ) : (
          <>
            <span className="mini-mark">W</span> WorkLens
          </>
        )}
      </div>
      {message.thinking && (
        <details className="thinking">
          <summary>推理摘要</summary>
          <Markdown text={message.thinking} />
        </details>
      )}
      <div className="prose">
        {message.role === "user" ? (
          <p className="whitespace-pre-wrap">{message.text}</p>
        ) : (
          <Markdown text={message.text} />
        )}
      </div>
      {message.error && <p className="error">{message.error}</p>}
      {message.role === "assistant" && message.text && (
        <button
          className="icon copy-message"
          aria-label="复制回答"
          onClick={() => void navigator.clipboard.writeText(message.text)}
        >
          <Copy size={14} />
        </button>
      )}
    </article>
  );
});

export function App() {
  const [data, setData] = useState<Bootstrap>();
  const [views, setViews] = useState<Record<string, ConversationView>>({});
  const [current, setCurrent] = useState<string>();
  const [page, setPage] = useState<"chat" | "settings">("chat");
  const [selection, setSelection] = useState<Selection>();
  const [text, setText] = useState("");
  const [error, setError] = useState("");
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
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
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
  useEffect(() => {
    if (follow.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [currentView?.messages, current]);
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
      follow.current = true;
    } catch (error) {
      setError(String(error));
    }
  }
  function newConversation() {
    navigation.current++;
    setDraftId(crypto.randomUUID());
    setCurrent(undefined);
    setSelection(data?.settings.defaults);
    setText("");
    setPage("chat");
    follow.current = true;
  }
  async function settings(patch: Partial<Settings>) {
    const result = await api.invoke("settings", patch);
    setData((previous) =>
      previous ? { ...previous, settings: result } : previous,
    );
  }
  async function send() {
    if (!selection || !text.trim() || sending || busy) return;
    const submissionKey = current ?? draftId;
    if (submissionLocks.current.has(submissionKey)) return;
    submissionLocks.current.add(submissionKey);
    setPendingSends((previous) => new Set(previous).add(submissionKey));
    const visit = navigation.current;
    setError("");
    follow.current = true;
    try {
      const view = await api.invoke("send", {
        conversationId: current,
        requestId: crypto.randomUUID(),
        text,
        selection,
      });
      acceptView(view);
      if (visit === navigation.current) {
        setCurrent(view.id);
        setText("");
        await settings({ lastConversation: view.id });
      }
    } catch (error) {
      setError(String(error));
    } finally {
      submissionLocks.current.delete(submissionKey);
      setPendingSends((previous) => {
        const next = new Set(previous);
        next.delete(submissionKey);
        return next;
      });
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
        <p>{error || "正在准备你的本地工作助手…"}</p>
        {error && <button onClick={() => location.reload()}>重新加载</button>}
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
            WorkLens<small>你的本地工作助手</small>
          </span>
        </div>
        <button className="new-chat" onClick={newConversation}>
          <Plus size={17} />
          新建会话<kbd>⌘ / Ctrl N</kbd>
        </button>
        <div className="section-label">
          历史会话 <span>{data.conversations.length || ""}</span>
        </div>
        <nav aria-label="会话列表" className="conversation-list">
          {!data.conversations.length && (
            <p className="sidebar-empty">暂无历史会话</p>
          )}
          {data.conversations.map((conversation) => (
            <div
              key={conversation.id}
              className={`conversation-item ${current === conversation.id && page === "chat" ? "selected" : ""}`}
            >
              <button
                className="conversation-open"
                onClick={() => void open(conversation.id)}
              >
                <span className="conversation-title">
                  {active(conversation.phase) && (
                    <LoaderCircle size={13} className="spin" />
                  )}
                  {conversation.title}
                </span>
                <span className="conversation-meta">
                  {active(conversation.phase)
                    ? labels[conversation.phase]
                    : (conversation.selection?.model ?? "未选择模型")}{" "}
                  ·{" "}
                  {new Date(conversation.updatedAt).toLocaleDateString(
                    "zh-CN",
                    { month: "numeric", day: "numeric" },
                  )}
                </span>
              </button>
              <div className="conversation-actions">
                <button
                  className="icon"
                  aria-label={"重命名 " + conversation.title}
                  title="重命名会话"
                  onClick={() =>
                    setDialog({
                      type: "rename",
                      id: conversation.id,
                      title: conversation.title,
                    })
                  }
                >
                  <Pencil size={14} />
                </button>
                <button
                  className="icon danger"
                  aria-label={"删除 " + conversation.title}
                  title="删除会话"
                  onClick={() =>
                    setDialog({
                      type: "delete",
                      id: conversation.id,
                      title: conversation.title,
                    })
                  }
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button
            className={
              page === "settings"
                ? "sidebar-settings selected"
                : "sidebar-settings"
            }
            onClick={() => setPage("settings")}
          >
            <SettingsIcon size={18} />
            设置
          </button>
        </div>
      </aside>
      <main className="main-content">
        {page === "settings" ? (
          <SettingsPage
            data={data}
            save={settings}
            refresh={refresh}
            onBack={() => setPage("chat")}
            onError={setError}
          />
        ) : (
          <>
            <header className="chat-header">
              <div>
                <span className="eyebrow">本地对话</span>
                <h1>{currentView?.title ?? "新的开始"}</h1>
              </div>
              {currentView && (
                <span
                  role="status"
                  className={busy ? "run-status running" : "run-status"}
                >
                  {busy && <LoaderCircle className="spin" size={13} />}{" "}
                  {currentView.statusDetail ?? labels[currentView.phase]}
                </span>
              )}
            </header>
            <div
              className="message-scroll"
              ref={scroll}
              onScroll={() => {
                const el = scroll.current;
                if (el)
                  follow.current =
                    el.scrollHeight - el.scrollTop - el.clientHeight < 100;
              }}
            >
              {!currentView?.messages.length ? (
                <div className="welcome">
                  <span className="eyebrow">一点想法，一起完成</span>
                  <h2>今天，我们从哪里开始？</h2>
                </div>
              ) : (
                <div className="messages">
                  {currentView.messages.map((message) => (
                    <Message key={message.id} message={message} />
                  ))}
                  {busy && (
                    <div className="working-indicator">
                      <LoaderCircle size={15} className="spin" />
                      {labels[currentView.phase]}…
                    </div>
                  )}
                  {currentView.error && (
                    <div className="error-panel">
                      <strong>这次运行未完成</strong>
                      <p>{currentView.error}</p>
                      <button
                        onClick={() =>
                          setText(
                            [...currentView.messages]
                              .reverse()
                              .find((m) => m.role === "user")?.text ?? "",
                          )
                        }
                      >
                        编辑后重试
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="composer-wrap">
              <div className="composer">
                <textarea
                  aria-label="消息"
                  placeholder={
                    availableModel?.available
                      ? "描述你的任务，也可以附上本地文件路径…"
                      : "先在设置中配置模型，即可开始工作…"
                  }
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                />
                <div className="composer-footer">
                  <span>
                    <span className="status-dot" />
                    {availableModel?.available
                      ? availableModel.name
                      : "尚未配置模型"}
                  </span>
                  {busy ? (
                    <button
                      className="send stop"
                      aria-label="停止运行"
                      disabled={currentView?.phase === "stopping"}
                      onClick={() =>
                        currentView?.runId &&
                        void api
                          .invoke("cancel", {
                            conversationId: currentView.id,
                            runId: currentView.runId,
                          })
                          .catch((e) => setError(String(e)))
                      }
                    >
                      <Square size={16} />
                    </button>
                  ) : (
                    <button
                      className="send"
                      aria-label="发送消息"
                      disabled={
                        sending || !text.trim() || !availableModel?.available
                      }
                      onClick={() => void send()}
                    >
                      {sending ? (
                        <LoaderCircle className="spin" size={18} />
                      ) : (
                        <ArrowUp size={19} />
                      )}
                    </button>
                  )}
                </div>
              </div>
              <div className="composer-note">
                Enter 发送 · Shift + Enter 换行
                <span>本地工具以你的系统用户权限运行</span>
              </div>
            </div>
          </>
        )}
      </main>
      {error && (
        <div role="alert" className="toast">
          <ShieldAlert size={17} />
          <span>{error.replace(/^Error: /, "")}</span>
          <button
            className="icon"
            aria-label="关闭错误"
            onClick={() => setError("")}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {showRecovery && data.recoveries.length > 0 && (
        <Modal
          title="上次有任务意外中断"
          onClose={() => setShowRecovery(false)}
        >
          <p>
            历史和已完成的工具结果仍由 Pi
            保存。工具可能已产生副作用，请先核对；WorkLens
            不会自动重新执行任务。
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
                  载入草稿，核对后继续
                </button>
                <button
                  className="danger"
                  onClick={() =>
                    void api
                      .invoke("dismissRecovery", { runId: item.runId })
                      .then(refresh)
                      .catch((e) => setError(String(e)))
                  }
                >
                  已核对，清除此恢复记录
                </button>
              </div>
            </div>
          ))}
        </Modal>
      )}
      {dialog && (
        <Modal
          title={dialog.type === "delete" ? "⚠ 永久删除会话" : "重命名会话"}
          onClose={() => setDialog(undefined)}
        >
          {dialog.type === "delete" ? (
            <p>
              将永久删除「{dialog.title}
              」及其会话记录，无法恢复。若它正在运行，会先停止；已修改的本地文件会保留。
            </p>
          ) : (
            <input
              aria-label="会话名称"
              autoFocus
              value={dialog.title}
              maxLength={120}
              onChange={(e) => setDialog({ ...dialog, title: e.target.value })}
            />
          )}
          <div className="actions">
            <button onClick={() => setDialog(undefined)}>取消</button>
            <button
              className={dialog.type === "delete" ? "danger-button" : "primary"}
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
                  .catch((e) => setError(String(e)))
              }
            >
              {dialog.type === "delete" ? "永久删除" : "保存名称"}
            </button>
          </div>
        </Modal>
      )}
    </div>
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
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} className="modal" onCancel={onClose}>
      <div className="modal-heading">
        <h2>{title}</h2>
        <button className="icon" aria-label="关闭对话框" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
function ModelPicker({
  data,
  value,
  disabled,
  onChange,
}: {
  data: Bootstrap;
  value?: Selection;
  disabled?: boolean;
  onChange: (value: Selection) => void;
}) {
  const provider = data.providers.find((p) => p.id === value?.provider);
  const model = provider?.models.find((m) => m.id === value?.model);
  return (
    <div className="model-picker">
      <Cpu size={15} />
      <select
        aria-label="模型服务商"
        value={value?.provider ?? ""}
        disabled={disabled}
        onChange={(e) => {
          const p = data.providers.find((p) => p.id === e.target.value)!;
          const m = p.models.find((m) => m.available) ?? p.models[0];
          onChange({
            provider: p.id,
            model: m.id,
            thinking: m.levels.includes("medium") ? "medium" : m.levels[0],
          });
        }}
      >
        <option value="" disabled>
          选择服务商
        </option>
        {value && !provider && (
          <option value={value.provider}>{value.provider} · 已不可用</option>
        )}
        {data.providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
            {p.configured ? "" : " · 未配置"}
          </option>
        ))}
      </select>
      <select
        aria-label="模型"
        value={value?.model ?? ""}
        disabled={disabled || !provider}
        onChange={(e) => {
          const m = provider!.models.find((m) => m.id === e.target.value)!;
          onChange({
            provider: provider!.id,
            model: m.id,
            thinking: m.levels.includes(value!.thinking)
              ? value!.thinking
              : m.levels[0],
          });
        }}
      >
        <option value="" disabled>
          选择模型
        </option>
        {value && !model && (
          <option value={value.model}>{value.model} · 请重新选择</option>
        )}
        {provider?.models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
      <select
        aria-label="推理等级"
        value={value?.thinking ?? "off"}
        disabled={disabled || !model}
        onChange={(e) =>
          value &&
          onChange({
            ...value,
            thinking: e.target.value as Selection["thinking"],
          })
        }
      >
        {(model?.levels ?? ["off"]).map((level) => (
          <option key={level} value={level}>
            推理 · {thinkingLabels[level]}
          </option>
        ))}
      </select>
    </div>
  );
}

function SettingsPage({
  data,
  save,
  refresh,
  onBack,
  onError,
}: {
  data: Bootstrap;
  save: (patch: Partial<Settings>) => Promise<void>;
  refresh: () => Promise<Bootstrap>;
  onBack: () => void;
  onError: (error: string) => void;
}) {
  const [selectedProvider, setSelectedProvider] = useState(
    data.settings.defaults?.provider ??
      data.providers.find((p) => p.configured)?.id ??
      data.providers[0]?.id,
  );
  const [defaults, setDefaults] = useState(data.settings.defaults);
  const [auth, setAuth] = useState<{
    loginId: string;
    steps: AuthStep[];
    prompt?: AuthStep;
  }>();
  const [answer, setAnswer] = useState("");
  const [status, setStatus] = useState("");
  const [testing, setTesting] = useState(false);
  const [query, setQuery] = useState("");
  const [azure, setAzure] = useState({
    baseUrl: "",
    resource: "",
    apiVersion: "",
    deployments: "",
  });
  const provider = data.providers.find((p) => p.id === selectedProvider);
  const model = data.providers
    .find((p) => p.id === defaults?.provider)
    ?.models.find((m) => m.id === defaults?.model);
  useEffect(
    () =>
      api.onAuth((step) => {
        setAuth((previous) => {
          if (!previous || previous.loginId !== step.loginId) return previous;
          if (step.type === "prompt_cancelled")
            return { ...previous, prompt: undefined };
          if (step.promptId) {
            setAnswer("");
            return { ...previous, prompt: step };
          }
          return { ...previous, steps: [...previous.steps.slice(-8), step] };
        });
      }),
    [],
  );
  useEffect(
    () => () => {
      if (auth) void api.invoke("authCancel", { loginId: auth.loginId });
    },
    [auth?.loginId],
  );
  async function login(type: "api_key" | "oauth") {
    if (!provider) return;
    const loginId = crypto.randomUUID();
    setAuth({ loginId, steps: [] });
    setAnswer("");
    setStatus("");
    try {
      await api.invoke("login", { provider: provider.id, type, loginId });
      const next = await refresh();
      const p = next.providers.find((p) => p.id === provider.id);
      const m = p?.models.find((m) => m.available);
      if (!defaults && m)
        setDefaults({
          provider: provider.id,
          model: m.id,
          thinking: m.levels.includes("medium") ? "medium" : m.levels[0],
        });
      setStatus("认证成功，凭据已加密保存");
      setAuth(undefined);
    } catch (error) {
      setAuth(undefined);
      onError(String(error));
    }
  }
  return (
    <div className="settings-page">
      <header className="settings-header">
        <button className="icon" aria-label="返回对话" onClick={onBack}>
          <ArrowLeft size={20} />
        </button>
        <div>
          <span className="eyebrow">按你的习惯工作</span>
          <h1>设置</h1>
        </div>
        <span className="version">v{data.version}</span>
      </header>
      <div className="settings-scroll">
        <div className="settings-body">
          <section>
            <h2>模型服务</h2>
            <p className="section-description">
              连接你信任的模型。凭据由操作系统加密，只在本机主进程中使用。
            </p>
            <div className="provider-layout">
              <div className="provider-list">
                <input
                  aria-label="查找服务商"
                  placeholder="查找服务商…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                {data.providers
                  .filter((p) =>
                    `${p.name} ${p.id}`
                      .toLowerCase()
                      .includes(query.toLowerCase()),
                  )
                  .map((p) => (
                    <button
                      key={p.id}
                      className={p.id === selectedProvider ? "selected" : ""}
                      onClick={() => setSelectedProvider(p.id)}
                    >
                      <span>{p.name}</span>
                      {p.configured && <CheckCircle2 size={14} />}
                    </button>
                  ))}
              </div>
              <div className="provider-detail">
                {provider && (
                  <>
                    <div className="provider-heading">
                      <div className="provider-monogram">
                        {provider.name.slice(0, 1)}
                      </div>
                      <div>
                        <h3>{provider.name}</h3>
                        <span className="subtle">
                          {provider.models.length} 个模型
                        </span>
                      </div>
                      <span
                        className={
                          provider.configured ? "badge configured" : "badge"
                        }
                      >
                        {provider.configured ? "已配置" : "未配置"}
                      </span>
                    </div>
                    <div className="verification">
                      Pi 内置 · WorkLens 尚未实测
                    </div>
                    {provider.credentialError && (
                      <p role="alert" className="error">
                        {provider.credentialError}
                      </p>
                    )}
                    {provider.connection && (
                      <p
                        className={provider.connection.ok ? "subtle" : "error"}
                      >
                        {provider.connection.message}
                      </p>
                    )}
                    <p className="provider-help">
                      认证方式由 Pi
                      提供。选择下方方式，按提示完成配置。替换凭据时请重新输入。
                    </p>
                    <div className="auth-methods">
                      {provider.methods.map((method) =>
                        method.interactive ? (
                          <button
                            key={method.type}
                            disabled={!!auth}
                            onClick={() => void login(method.type)}
                          >
                            {method.type === "oauth" ? "登录" : "配置"} ·{" "}
                            {method.name}
                          </button>
                        ) : (
                          <div key={method.type} className="ambient">
                            <strong>{method.name}</strong>
                            <p>
                              此服务使用外部环境凭据。配置服务商要求的系统环境或凭据文件后，点击刷新状态。
                            </p>
                          </div>
                        ),
                      )}
                    </div>
                    <div className="actions">
                      <button
                        onClick={() =>
                          void refresh()
                            .then(() => setStatus("模型与认证状态已刷新"))
                            .catch((e) => onError(String(e)))
                        }
                      >
                        刷新状态
                      </button>
                      <button
                        onClick={() =>
                          void api
                            .invoke("refreshModels", { provider: provider.id })
                            .then((message) => {
                              setStatus(message);
                              return refresh();
                            })
                            .catch((e) => onError(String(e)))
                        }
                      >
                        刷新模型目录
                      </button>
                      {(provider.configured || provider.credentialError) && (
                        <button
                          className="danger"
                          onClick={() =>
                            void api
                              .invoke("logout", { provider: provider.id })
                              .then(refresh)
                              .then(() => setStatus("已删除此服务的本地凭据"))
                              .catch((e) => onError(String(e)))
                          }
                        >
                          移除凭据
                        </button>
                      )}
                    </div>
                    {provider.id === "azure-openai-responses" && (
                      <details className="azure">
                        <summary>Azure 端点与部署映射</summary>
                        <label>
                          基础地址
                          <input
                            value={azure.baseUrl}
                            onChange={(e) =>
                              setAzure({ ...azure, baseUrl: e.target.value })
                            }
                            placeholder="https://资源名.openai.azure.com"
                          />
                        </label>
                        <label>
                          资源名（可替代基础地址）
                          <input
                            value={azure.resource}
                            onChange={(e) =>
                              setAzure({ ...azure, resource: e.target.value })
                            }
                          />
                        </label>
                        <label>
                          接口版本（可选）
                          <input
                            value={azure.apiVersion}
                            onChange={(e) =>
                              setAzure({ ...azure, apiVersion: e.target.value })
                            }
                          />
                        </label>
                        <label>
                          模型到部署名称
                          <input
                            value={azure.deployments}
                            onChange={(e) =>
                              setAzure({
                                ...azure,
                                deployments: e.target.value,
                              })
                            }
                            placeholder="gpt-4.1=我的部署名称"
                          />
                        </label>
                        <button
                          onClick={() =>
                            void api
                              .invoke("azure", azure)
                              .then(() => setStatus("Azure 配置已加密保存"))
                              .catch((e) => onError(String(e)))
                          }
                        >
                          保存 Azure 配置
                        </button>
                      </details>
                    )}
                  </>
                )}
              </div>
            </div>
          </section>
          <section>
            <h2>默认模型</h2>
            <p className="section-description">
              用于新会话。每个会话都可以独立选择模型与推理等级。
            </p>
            <div className="settings-card">
              <ModelPicker
                data={data}
                value={defaults}
                onChange={setDefaults}
              />
              {model && (
                <div className="model-capabilities">
                  <span>{model.contextWindow.toLocaleString()} 上下文</span>
                  <span>{model.reasoning ? "支持推理" : "不支持推理"}</span>
                  <span>
                    {model.image ? "支持图片输入（首版仅文本）" : "文本输入"}
                  </span>
                </div>
              )}
              <div className="actions">
                <button
                  className="primary"
                  disabled={!defaults}
                  onClick={() =>
                    defaults &&
                    void save({ defaults })
                      .then(() => setStatus("默认模型已保存"))
                      .catch((e) => onError(String(e)))
                  }
                >
                  <Check size={15} />
                  保存默认模型
                </button>
                <button
                  disabled={!model?.available || testing}
                  onClick={() => {
                    if (!defaults) return;
                    setTesting(true);
                    setStatus("正在执行受限文本连接测试…");
                    void api
                      .invoke("test", defaults)
                      .then(setStatus)
                      .catch((e) => onError(String(e)))
                      .finally(() => setTesting(false));
                  }}
                >
                  {testing && <LoaderCircle className="spin" size={15} />}
                  测试连接
                </button>
              </div>
              <p className="subtle">
                连接测试会发送一次简短模型请求，不调用本地工具。
              </p>
            </div>
          </section>
          <section>
            <h2>外观</h2>
            <div className="theme-options">
              {(["light", "dark", "system"] as const).map((theme) => (
                <button
                  key={theme}
                  className={data.settings.theme === theme ? "selected" : ""}
                  onClick={() =>
                    void save({ theme }).catch((e) => onError(String(e)))
                  }
                >
                  <div className={`theme-preview ${theme}`}>
                    <span />
                    <span />
                  </div>
                  <span>
                    {{ light: "浅色", dark: "深色", system: "跟随系统" }[theme]}
                  </span>
                  {data.settings.theme === theme && <Check size={14} />}
                </button>
              ))}
            </div>
          </section>
          <section>
            <h2>本地数据与隐私</h2>
            <div className="settings-card data-info">
              <dl>
                <dt>数据根目录</dt>
                <dd>{data.paths.root}</dd>
                <dt>初始运行目录</dt>
                <dd>{data.paths.runtime}</dd>
                <dt>会话历史</dt>
                <dd>{data.paths.sessions}</dd>
                <dt>设置与加密凭据</dt>
                <dd>{data.paths.userData}</dd>
              </dl>
            </div>
            {data.diagnostics.map((diagnostic, i) => (
              <p key={i} className="error">
                {diagnostic}
              </p>
            ))}
          </section>
          {status && (
            <div role="status" className="settings-status">
              <CheckCircle2 size={17} />
              {status}
            </div>
          )}
        </div>
      </div>
      {auth && (
        <Modal
          title={`连接 ${provider?.name ?? "模型服务"}`}
          onClose={() => {
            void api.invoke("authCancel", { loginId: auth.loginId });
            setAuth(undefined);
          }}
        >
          {auth.steps.map((step, index) => (
            <div key={index}>
              <p>{step.message}</p>
              {step.userCode && (
                <pre className="device-code">{step.userCode}</pre>
              )}
              {step.url && (
                <button
                  onClick={() =>
                    void api
                      .invoke("external", { url: step.url! })
                      .catch((e) => onError(String(e)))
                  }
                >
                  在浏览器中继续
                </button>
              )}
            </div>
          ))}
          {auth.prompt ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (auth.prompt?.promptId)
                  void api
                    .invoke("authReply", {
                      loginId: auth.loginId,
                      promptId: auth.prompt.promptId,
                      value: answer,
                    })
                    .then(() => {
                      setAuth((current) =>
                        current &&
                        current.prompt?.promptId === auth.prompt?.promptId
                          ? { ...current, prompt: undefined }
                          : current,
                      );
                      setAnswer("");
                    })
                    .catch((e) => onError(String(e)));
              }}
            >
              <label>
                {auth.prompt.message}
                {auth.prompt.type === "select" ? (
                  <select
                    autoFocus
                    value={answer}
                    onChange={(e) => setAnswer(e.target.value)}
                  >
                    <option value="">请选择</option>
                    {auth.prompt.options?.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    autoFocus
                    type={auth.prompt.type === "secret" ? "password" : "text"}
                    autoComplete="off"
                    placeholder={auth.prompt.placeholder}
                    value={answer}
                    onChange={(e) => setAnswer(e.target.value)}
                  />
                )}
              </label>
              <button className="primary" type="submit">
                继续
              </button>
            </form>
          ) : (
            <p className="waiting">
              <LoaderCircle className="spin" size={16} />
              等待认证流程…
            </p>
          )}
        </Modal>
      )}
    </div>
  );
}
