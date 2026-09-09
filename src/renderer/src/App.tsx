import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import {
  Plus,
  Settings as SettingsIcon,
  ArrowLeft,
  Check,
  X,
  Trash2,
  Pencil,
  ShieldAlert,
  CheckCircle2,
  LoaderCircle,
  RefreshCw,
  FolderOpen,
} from "lucide-react";
import { AgentThread } from "@/components/worklens/AgentThread";
import { ModelMenu } from "@/components/worklens/ModelMenu";
import type {
  AuthStep,
  Bootstrap,
  ConversationView,
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
export function App() {
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
    if (notice?.type !== "success") return;
    const timer = setTimeout(() => setNotice(undefined), 3200);
    return () => clearTimeout(timer);
  }, [notice]);
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
            onError={notifyError}
            onSuccess={notifySuccess}
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
                onManage: () => setPage("settings"),
              }}
            />
          </>
        )}
      </main>
      {notice && (
        <div
          role={notice.type === "error" ? "alert" : "status"}
          className={`toast ${notice.type}`}
        >
          {notice.type === "error" ? (
            <ShieldAlert size={17} />
          ) : (
            <CheckCircle2 size={17} />
          )}
          <span>
            {notice.type === "error" &&
            /模型尚未配置|模型.*不可用/.test(notice.text)
              ? "请先选择并连接一个可用模型。"
              : notice.text.replace(/^Error: /, "")}
          </span>
          {notice.type === "error" &&
            /模型尚未配置|模型.*不可用/.test(notice.text) && (
              <button
                className="toast-action"
                onClick={() => {
                  setPage("settings");
                  setNotice(undefined);
                }}
              >
                前往设置
              </button>
            )}
          <button
            className="icon"
            aria-label="关闭提示"
            onClick={() => setNotice(undefined)}
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
                      .catch((e) => notifyError(String(e)))
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
                  .catch((e) => notifyError(String(e)))
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
function PathRow({
  label,
  path,
  onOpen,
}: {
  label: string;
  path: string;
  onOpen: () => void;
}) {
  return (
    <>
      <dt>{label}</dt>
      <dd>
        <span>{path}</span>
        <button
          className="icon"
          aria-label={`在文件管理器中打开${label}`}
          title="在文件管理器中打开"
          onClick={onOpen}
        >
          <FolderOpen size={13} />
        </button>
      </dd>
    </>
  );
}

function SettingsPage({
  data,
  save,
  refresh,
  onBack,
  onError,
  onSuccess,
}: {
  data: Bootstrap;
  save: (patch: Partial<Settings>) => Promise<void>;
  refresh: () => Promise<Bootstrap>;
  onBack: () => void;
  onError: (error: string) => void;
  onSuccess: (message: string) => void;
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
  const [testing, setTesting] = useState(false);
  const [query, setQuery] = useState("");
  const [removeCredential, setRemoveCredential] = useState<{
    id: string;
    name: string;
  }>();
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
      onSuccess("认证成功，凭据已加密保存");
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
          <section id="model-service">
            <h2>模型服务</h2>
            <p className="section-description">
              连接你信任的模型。凭据由操作系统加密，只在本机主进程中使用。
            </p>
            <div className="provider-layout">
              <div className="provider-list">
                <div className="provider-list-head">
                  <span>服务商</span>
                  <button
                    className="ghost small"
                    title="重新检测所有服务商的本地凭据是否已生效"
                    onClick={() =>
                      void refresh()
                        .then(() => onSuccess("已配置状态已刷新"))
                        .catch((e) => onError(String(e)))
                    }
                  >
                    <RefreshCw size={12} />
                    刷新
                  </button>
                </div>
                <div className="search-input">
                  <input
                    aria-label="查找服务商"
                    placeholder="查找服务商…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  {query && (
                    <button
                      className="icon clear"
                      aria-label="清除搜索"
                      onClick={() => setQuery("")}
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>
                {[...data.providers]
                  .filter((p) =>
                    `${p.name} ${p.id}`
                      .toLowerCase()
                      .includes(query.toLowerCase()),
                  )
                  .sort(
                    (a, b) => Number(b.configured) - Number(a.configured),
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
                        {provider.configured && <CheckCircle2 size={11} />}
                        {provider.configured ? "已配置" : "未配置"}
                      </span>
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
                    <h4 className="detail-label">认证方式</h4>
                    <p className="subtle auth-methods-hint">
                      {provider.methods.length > 1
                        ? "以下方式二选一即可，无需同时配置。"
                        : "选择以下方式完成连接。"}
                    </p>
                    <div className="auth-methods">
                      {[...provider.methods]
                        .sort(
                          (a, b) => Number(b.interactive) - Number(a.interactive),
                        )
                        .map((method, index) => (
                          <Fragment key={method.type}>
                            {index > 0 && (
                              <div className="auth-divider">或</div>
                            )}
                            {method.interactive ? (
                              <button
                                disabled={!!auth}
                                onClick={() => void login(method.type)}
                              >
                                {method.type === "oauth" ? "登录" : "配置"} ·{" "}
                                {method.name}
                              </button>
                            ) : (
                              <div className="ambient">
                                <strong>{method.name}（可选替代方式）</strong>
                                <p>
                                  适合已经在系统环境变量或凭据文件中配置好密钥的场景。设置好后点击左侧"刷新"检测。
                                </p>
                              </div>
                            )}
                          </Fragment>
                        ))}
                    </div>
                    <h4 className="detail-label">操作</h4>
                    <div className="actions">
                      <button
                        title="重新从该服务商拉取最新的可用模型列表"
                        onClick={() => {
                          const beforeIds = new Set(
                            provider.models
                              .filter((m) => m.available)
                              .map((m) => m.id),
                          );
                          void api
                            .invoke("refreshModels", { provider: provider.id })
                            .then(() => refresh())
                            .then((next) => {
                              const updated = next.providers.find(
                                (p) => p.id === provider.id,
                              );
                              const afterIds = new Set(
                                (updated?.models ?? [])
                                  .filter((m) => m.available)
                                  .map((m) => m.id),
                              );
                              const added = [...afterIds].filter(
                                (id) => !beforeIds.has(id),
                              ).length;
                              const removed = [...beforeIds].filter(
                                (id) => !afterIds.has(id),
                              ).length;
                              onSuccess(
                                `现有 ${afterIds.size} 个可用模型` +
                                  (added || removed
                                    ? `（新增 ${added} 个，减少 ${removed} 个）`
                                    : "（无变化）"),
                              );
                            })
                            .catch((e) => onError(String(e)));
                        }}
                      >
                        <RefreshCw size={14} />
                        重新获取模型列表
                      </button>
                      {(provider.configured || provider.credentialError) && (
                        <button
                          className="danger"
                          onClick={() =>
                            setRemoveCredential({
                              id: provider.id,
                              name: provider.name,
                            })
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
                              .then(() => onSuccess("Azure 配置已加密保存"))
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
              用于新会话。每个会话都可以在对话输入框旁独立切换模型与推理等级。
            </p>
            <div className="settings-card">
              <ModelMenu
                data={data}
                value={defaults}
                onChange={setDefaults}
                onManage={() =>
                  document
                    .getElementById("model-service")
                    ?.scrollIntoView({ behavior: "smooth", block: "start" })
                }
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
                      .then(() => onSuccess("默认模型已保存"))
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
                    void api
                      .invoke("test", defaults)
                      .then(onSuccess)
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
            <p className="section-description">
              所有对话记录、模型凭据和设置都只保存在本机磁盘上，不会上传到任何服务器。
            </p>
            <div className="settings-card data-info">
              <dl>
                {(
                  [
                    ["数据根目录", "root"],
                    ["初始运行目录", "runtime"],
                    ["会话历史", "sessions"],
                    ["设置与加密凭据", "userData"],
                  ] as const
                ).map(([label, which]) => (
                  <PathRow
                    key={which}
                    label={label}
                    path={data.paths[which]}
                    onOpen={() =>
                      void api
                        .invoke("showPath", { which })
                        .catch((e) => onError(String(e)))
                    }
                  />
                ))}
              </dl>
            </div>
            {data.diagnostics.length > 0 && (
              <div className="data-diagnostics">
                {data.diagnostics.map((diagnostic, i) => (
                  <p key={i} className="error">
                    {diagnostic}
                  </p>
                ))}
              </div>
            )}
          </section>
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
      {removeCredential && (
        <Modal
          title="移除本地凭据"
          onClose={() => setRemoveCredential(undefined)}
        >
          <p>
            将删除「{removeCredential.name}
            」在本机保存的加密凭据，需要重新登录或重新配置才能再次使用该服务。不会影响其他已配置的服务商。
          </p>
          <div className="actions">
            <button onClick={() => setRemoveCredential(undefined)}>
              取消
            </button>
            <button
              className="danger-button"
              onClick={() =>
                void api
                  .invoke("logout", { provider: removeCredential.id })
                  .then(refresh)
                  .then(() => {
                    onSuccess(`已删除「${removeCredential.name}」的本地凭据`);
                    setRemoveCredential(undefined);
                  })
                  .catch((e) => onError(String(e)))
              }
            >
              确认移除
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
