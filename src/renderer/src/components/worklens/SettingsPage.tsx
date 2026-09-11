import { Hint } from "@/components/ui/tooltip";
import { ProviderIcon } from "./ProviderIcon";
import { useEffect, useRef, useState } from "react";
import {
  X,
  Cpu,
  FolderOpen,
  Info,
  Globe,
  LoaderCircle,
  Plus,
  Pencil,
  RefreshCw,
  Settings2,
  Unplug,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { Item, ItemGroup, ItemContent, ItemTitle, ItemDescription, ItemActions } from "@/components/ui/item";
import { Badge } from "@/components/ui/badge";
import { SearchInput } from "./SearchInput";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import {
  Accordion,
  AccordionItem,
  AccordionContent,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Switch } from "@/components/ui/switch";
import { ProviderDialog } from "./ProviderDialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { systemText } from "@/lib/system-text";
import { useLocale } from "@/lib/locale";
import type {
  Bootstrap,
  ProviderInfo,
  Settings,
} from "../../../../shared/contracts";
import "./settings.css";

export type SettingsSection = "general" | "providers" | "models";
type Props = {
  data: Bootstrap;
  initialSection?: SettingsSection;
  save: (patch: Partial<Settings>) => Promise<void>;
  refresh: () => Promise<Bootstrap>;
  onBack: () => void;
  onError: (message: string) => void;
  onSuccess: (message: string) => void;
};
const api = window.worklens;
export function SettingsPage({
  data,
  initialSection = "providers",
  save,
  refresh,
  onBack,
  onError,
  onSuccess,
}: Props) {
  const { t, language, setLanguage } = useLocale();
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [query, setQuery] = useState("");
  const [providerScope, setProviderScope] = useState("all");
  const [modelQuery, setModelQuery] = useState("");
  const [scope, setScope] = useState("connected");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [limits, setLimits] = useState<Record<string, number>>({});
  const [connect, setConnect] = useState<ProviderInfo>();
  const [remove, setRemove] = useState<ProviderInfo>();
  const [removing, setRemoving] = useState(false);
  const [refreshing, setRefreshing] = useState<string>();
  const [testing, setTesting] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<
    Record<string, { ok: boolean; text: string }>
  >({});
  const [hiddenModels, setHiddenModels] = useState(
    () => new Set(data.settings.hiddenModels ?? []),
  );
  const hiddenRef = useRef(hiddenModels);
  const confirmedHidden = useRef(hiddenModels);
  const visibilityQueue = useRef(Promise.resolve());
  const pendingRef = useRef(new Set<string>());
  const [pendingVisibility, setPendingVisibility] = useState(new Set<string>());
  useEffect(() => {
    if (pendingRef.current.size) return;
    const next = new Set(data.settings.hiddenModels ?? []);
    confirmedHidden.current = next;
    hiddenRef.current = next;
    setHiddenModels(next);
  }, [data.settings.hiddenModels]);
  function openConnect(provider: ProviderInfo) {
    setConnect(provider);
  }
  function goToProviders(provider?: ProviderInfo) {
    setQuery(provider?.name ?? "");
    setProviderScope("all");
    setSection("providers");
  }
  async function refreshProvider(id?: string) {
    if (refreshing) return;
    setRefreshing(id ?? "all");
    try {
      if (id) await api.invoke("refreshModels", { provider: id });
      await refresh();
      onSuccess(
        id
          ? t("Models refreshed", "模型已刷新")
          : t("Providers refreshed", "供应商已刷新"),
      );
    } catch (e) {
      onError(systemText(String(e), language));
    } finally {
      setRefreshing(undefined);
    }
  }
  function toggleModel(key: string, visible: boolean) {
    if (pendingRef.current.has(key)) return;
    const optimistic = new Set(hiddenRef.current);
    visible ? optimistic.delete(key) : optimistic.add(key);
    hiddenRef.current = optimistic;
    setHiddenModels(optimistic);
    pendingRef.current.add(key);
    setPendingVisibility(new Set(pendingRef.current));
    // The API saves the whole array. Serialize writes to preserve independent
    // clicks while allowing other model switches to remain interactive.
    visibilityQueue.current = visibilityQueue.current.then(async () => {
      const next = new Set(confirmedHidden.current);
      visible ? next.delete(key) : next.add(key);
      try {
        await save({ hiddenModels: [...next] });
        confirmedHidden.current = next;
        onSuccess(t("Saved", "已保存"));
      } catch (e) {
        const rollback = new Set(hiddenRef.current);
        confirmedHidden.current.has(key)
          ? rollback.add(key)
          : rollback.delete(key);
        hiddenRef.current = rollback;
        setHiddenModels(rollback);
        onError(systemText(String(e), language));
      } finally {
        pendingRef.current.delete(key);
        setPendingVisibility(new Set(pendingRef.current));
      }
    });
  }
  async function testModel(
    provider: ProviderInfo,
    model: ProviderInfo["models"][number],
  ) {
    const key = provider.id + "/" + model.id;
    setTesting((prev) => new Set(prev).add(key));
    setResults((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    try {
      await api.invoke("test", {
        provider: provider.id,
        model: model.id,
        thinking: model.levels.includes("medium") ? "medium" : model.levels[0],
      });
      onSuccess(t("Connection successful", "连接成功"));
      setResults((prev) => ({
        ...prev,
        [key]: { ok: true, text: t("Connection successful", "连接成功") },
      }));
    } catch (e) {
      onError(systemText(String(e), language));
      setResults((prev) => ({
        ...prev,
        [key]: { ok: false, text: String(e).replace(/^Error: /, "") },
      }));
    } finally {
      setTesting((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }
  const filtered = data.providers.filter((p) => {
    const isConnected = Boolean(p.configured || p.credentialType || p.credentialError);
    return (p.name + " " + p.id).toLowerCase().includes(query.toLowerCase()) &&
      (providerScope === "all" || (providerScope === "connected" ? isConnected : !isConnected));
  });
  const connected = filtered.filter(
    (p) => p.configured || p.credentialType || p.credentialError,
  );
  const others = filtered.filter((p) => !connected.includes(p));
  const modelGroups = [...data.providers]
    .sort((a, b) => Number(b.configured) - Number(a.configured))
    .map((p) => ({
      ...p,
      models: p.models.filter((m) => {
        const key = p.id + "/" + m.id;
        return (
          (scope !== "connected" || p.configured) &&
          (scope !== "visible" || (m.available && !hiddenModels.has(key))) &&
          (p.name + " " + m.name + " " + m.id)
            .toLowerCase()
            .includes(modelQuery.toLowerCase())
        );
      }),
    }))
    .filter((p) => p.models.length);
  const methodName = (p: ProviderInfo) =>
    p.methods.find((m) => m.type === p.credentialType)?.name ??
    (p.configured
      ? t("System credentials", "系统凭据")
      : t("Not connected", "未连接"));
  const nav = [
    { id: "general" as const, label: t("General", "通用"), icon: Settings2 },
    { id: "providers" as const, label: t("Providers", "供应商"), icon: Globe },
    { id: "models" as const, label: t("Models", "模型"), icon: Cpu },
  ];
  function providerRows(items: ProviderInfo[], isConnected: boolean) {
    return (
      <ItemGroup className="settings-list settings-provider-list">
        {items.map((p) => (
          <Item size="sm" role="listitem" className="settings-entry" key={p.id}>
            <ItemContent className="settings-entry-copy">
              <ItemTitle className="settings-entry-title">
                <ProviderIcon provider={p.id} />
                {p.name}
                {isConnected && (
                  <Badge variant="outline">{methodName(p)}</Badge>
                )}
              </ItemTitle>
              {p.credentialError && (
                <ItemDescription className="settings-entry-description">
                  {t(
                      "Saved credentials need attention",
                      "已保存的凭据需要检查",
                    )}
                </ItemDescription>
              )}
            </ItemContent>
            <ItemActions className="settings-entry-actions">
              {isConnected ? (
                <>
                  {p.methods.some((m) => m.interactive) && (
                    <TooltipIconButton
                      tooltip={t("Manage", "管理")}
                      onClick={() => openConnect(p)}
                    >
                      <Pencil />
                    </TooltipIconButton>
                  )}
                  {(p.credentialType || p.credentialError) && (
                    <TooltipIconButton
                      tooltip={t("Disconnect", "断开连接")}
                      onClick={() => setRemove(p)}
                    >
                      <Unplug />
                    </TooltipIconButton>
                  )}
                </>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => openConnect(p)}
                >
                  <Plus data-icon="inline-start" />
                  {t("Connect", "连接")}
                </Button>
              )}
            </ItemActions>
          </Item>
        ))}
      </ItemGroup>
    );
  }
  return (
    <div className="settings-workspace">
      <aside className="settings-navigation">
        <nav aria-label={t("Settings sections", "设置分类")}>
          {nav.map(({ id, label, icon: Icon }) => (
            <Button
              key={id}
              variant={section === id ? "secondary" : "ghost"}
              aria-current={section === id ? "page" : undefined}
              onClick={() => setSection(id)}
            >
              <Icon data-icon="inline-start" />
              {label}
            </Button>
          ))}
        </nav>
      </aside>
      <div className="settings-pane">
        <header className="settings-page-heading">
          <h1>{nav.find((n) => n.id === section)?.label}</h1>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onBack}
            aria-label={t("Close settings", "关闭设置")}
          >
            <X />
          </Button>
        </header>
        <div className="settings-scroll">
          <div className="settings-page-content" data-section={section}>
            {section === "providers" && (
              <>
                <div className="settings-toolbar">
                  <SearchInput
                    aria-label={t("Search providers", "搜索供应商")}
                    placeholder={t("Search providers…", "搜索供应商…")}
                    value={query}
                    onValueChange={setQuery}
                  />
                  <NativeSelect aria-label={t("Filter providers", "筛选供应商")} value={providerScope} onChange={(event) => setProviderScope(event.target.value)}>
                    <NativeSelectOption value="all">{t("All providers", "全部供应商")}</NativeSelectOption>
                    <NativeSelectOption value="connected">{t("Connected", "已连接")}</NativeSelectOption>
                    <NativeSelectOption value="available">{t("Available", "可连接")}</NativeSelectOption>
                  </NativeSelect>
                  <TooltipIconButton
                    variant="ghost"
                        className="size-[38px] p-0"
                    size="icon"
                    aria-label={t("Refresh providers", "刷新供应商")}
                    tooltip={t("Refresh providers", "刷新供应商")}
                    disabled={!!refreshing}
                    onClick={() => void refreshProvider()}
                  >
                    <RefreshCw
                      className={refreshing === "all" ? "spin" : undefined}
                    />
                  </TooltipIconButton>
                </div>
                {!!connected.length && (
                  <section className="settings-section">
                    <h2 data-slot="settings-section-title">
                      {t("Connected", "已连接")}
                    </h2>
                    {providerRows(connected, true)}
                  </section>
                )}
                {!!others.length && (
                  <section className="settings-section">
                    <h2 data-slot="settings-section-title">
                      {t("Available", "可连接")}
                    </h2>
                    {providerRows(others, false)}
                  </section>
                )}
                {!filtered.length && (
                  <p className="settings-empty">
                    {t("No providers match your filters.", "没有匹配的供应商。")}
                  </p>
                )}
              </>
            )}
            {section === "models" && (
              <>
                <div className="settings-toolbar">
                  <SearchInput
                    aria-label={t("Search models", "搜索模型")}
                    placeholder={t(
                      "Search models or providers…",
                      "搜索模型或供应商…",
                    )}
                    value={modelQuery}
                    onValueChange={(value) => {
                      setModelQuery(value);
                      setExpanded({});
                      setLimits({});
                    }}
                  />
                  <NativeSelect
                    aria-label={t("Model filter", "模型筛选")}
                    value={scope}
                    onChange={(e) => setScope(e.target.value)}
                  >
                    <NativeSelectOption value="all">
                      {t("All models", "全部模型")}
                    </NativeSelectOption>
                    <NativeSelectOption value="connected">
                      {t("Connected", "已连接")}
                    </NativeSelectOption>
                    <NativeSelectOption value="visible">
                      {t("Shown in chat", "对话中显示")}
                    </NativeSelectOption>
                  </NativeSelect>
                </div>
                <Accordion
                  multiple
                  value={modelGroups.filter((p) =>
                    expanded[p.id] ?? (!!modelQuery.trim() || p.configured)
                  ).map((p) => p.id)}
                  onValueChange={(values) => setExpanded((prev) => ({
                    ...prev,
                    ...Object.fromEntries(modelGroups.map((p) => [p.id, values.includes(p.id)])),
                  }))}
                >
                {modelGroups.map((p) => (
                  <AccordionItem value={p.id} key={p.id}>
                    <div className="settings-accordion-heading">
                      <AccordionTrigger>
                        <span className="flex items-center gap-2">
                          <ProviderIcon provider={p.id} />
                          {p.name}
                          <span className="text-muted-foreground">{p.models.length}</span>
                        </span>
                      </AccordionTrigger>
                      {!p.configured && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="shrink-0"
                          aria-label={t("Go to Providers: ", "前往供应商设置：") + p.name}
                          onClick={() => goToProviders(p)}
                        >
                          {t("Go to Providers", "前往供应商设置")}
                        </Button>
                      )}
                      <TooltipIconButton
                        variant="ghost"
                        className="size-8 p-0"
                        size="icon-sm"
                        aria-label={
                          t("Refresh models: ", "刷新模型：") + p.name
                        }
                        tooltip={t("Refresh models", "刷新模型")}
                        disabled={!!refreshing}
                        onClick={() => void refreshProvider(p.id)}
                      >
                        <RefreshCw
                          className={refreshing === p.id ? "spin" : undefined}
                        />
                      </TooltipIconButton>
                    </div>
                    <AccordionContent className="settings-model-panel">
                      <div className="settings-list">
                        {p.models.slice(0, limits[p.id] ?? 50).map((m) => {
                          const key = p.id + "/" + m.id;
                          return (
                            <div className="settings-entry" key={key}>
                              <div className="settings-entry-copy settings-model-copy">
                                <div className="settings-entry-title">
                                  {m.name}
                                </div>
                                <Hint content={t("Context window and capabilities", "上下文窗口与能力")}><div className="settings-entry-description" tabIndex={0}>
                                  {Intl.NumberFormat(language, {
                                    notation: "compact",
                                    maximumFractionDigits: 1,
                                  }).format(
                                    m.contextWindow,
                                  )}
                                  {m.reasoning
                                    ? t(" · Thinking", " · 推理")
                                    : ""}
                                  {m.image ? t(" · Vision", " · 图片") : ""}
                                </div></Hint>
                                {results[key] && !results[key].ok && (
                                  <p
                                    className="model-test-result failed"
                                    role="status"
                                  >
                                    {systemText(results[key].text, language)}
                                  </p>
                                )}
                              </div>
                              <div className="settings-entry-actions">
                                {m.available ? (
                                  <>
                                    <TooltipIconButton
                                      variant="ghost"
                                      size="icon-xs"
                                      disabled={testing.has(key)}
                                      aria-label={
                                        t("Test connection: ", "测试连接：") +
                                        m.name
                                      }
                                      tooltip={t("Test connection · sends a short request", "测试连接 · 发送简短请求")}
                                      onClick={() => void testModel(p, m)}
                                    >
                                      {testing.has(key) ? (
                                        <LoaderCircle className="spin" />
                                      ) : (
                                        <Zap />
                                      )}
                                    </TooltipIconButton>
                                    <TooltipProvider>
                                      <Tooltip>
                                        <TooltipTrigger render={
                                    <Switch
                                      size="sm"
                                      aria-label={
                                        t("Show in chat: ", "在对话中显示：") +
                                        m.name
                                      }
                                      checked={!hiddenModels.has(key)}
                                      disabled={pendingVisibility.has(key)}
                                      onCheckedChange={(checked) =>
                                        void toggleModel(key, checked)
                                      }
                                    />
                                        } />
                                        <TooltipContent side="bottom">
                                          {t("Show in chat", "在对话中显示")}
                                        </TooltipContent>
                                      </Tooltip>
                                    </TooltipProvider>
                                  </>
                                ) : p.configured ? (
                                  <Hint content={t(
                                      "Not available with the current connection. Manage authentication in Providers.",
                                      "当前连接下不可用。可在供应商页面管理认证。",
                                    )}><span
                                    className="text-xs text-muted-foreground"
                                    tabIndex={0}
                                  >
                                    {t("Unavailable", "不可用")}
                                  </span></Hint>
                                ) : null}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      {p.models.length > (limits[p.id] ?? 50) && (
                        <Button
                          variant="ghost"
                          className="mt-3"
                          onClick={() =>
                            setLimits((prev) => ({
                              ...prev,
                              [p.id]: (prev[p.id] ?? 50) + 50,
                            }))
                          }
                        >
                          {t("Show more models", "显示更多模型")}
                        </Button>
                      )}
                    </AccordionContent>
                  </AccordionItem>
                ))}
                </Accordion>
                {!modelGroups.length && (
                  <div className="settings-empty">
                    {scope === "connected" &&
                    !modelQuery.trim() &&
                    !data.providers.some((p) => p.configured) ? (
                      <>
                        <p className="font-medium text-foreground">
                          {t("No providers connected", "尚未连接供应商")}
                        </p>
                        <p className="mt-2">
                          {t(
                            "Connect a provider to use its models.",
                            "连接供应商后即可使用其模型。",
                          )}
                        </p>
                        <Button
                          variant="outline"
                          className="mt-4"
                          onClick={() => goToProviders()}
                        >
                          {t("Go to Providers", "前往供应商设置")}
                        </Button>
                      </>
                    ) : (
                      <p>
                        {t(
                          "No models match these filters. Try another search or filter.",
                          "没有符合条件的模型，请调整搜索或筛选条件。",
                        )}
                      </p>
                    )}
                  </div>
                )}
              </>
            )}
            {section === "general" && (
              <>
                <section className="settings-section">
                  <h2 data-slot="settings-section-title">
                    {t("Preferences", "偏好")}
                  </h2>
                  <ItemGroup className="settings-list">
                    <Item size="sm" role="listitem" className="settings-entry">
                      <ItemContent className="settings-entry-copy">
                        <ItemTitle className="settings-entry-title">
                          {t("Language", "语言")}
                        </ItemTitle>
                      </ItemContent>
                      <NativeSelect
                        aria-label={t("Language", "语言")}
                        value={language}
                        onChange={(e) => {
                          const next = e.target.value as "en" | "zh";
                          try {
                            localStorage.setItem("worklens.language", next);
                            setLanguage(next);
                            onSuccess(next === "en" ? "Saved" : "已保存");
                          } catch {
                            onError(
                              t("Could not save language", "语言保存失败"),
                            );
                          }
                        }}
                      >
                        <NativeSelectOption value="en">
                          English
                        </NativeSelectOption>
                        <NativeSelectOption value="zh">
                          简体中文
                        </NativeSelectOption>
                      </NativeSelect>
                    </Item>
                    <Item size="sm" role="listitem" className="settings-entry">
                      <ItemTitle className="settings-entry-title">
                        {t("Appearance", "外观")}
                      </ItemTitle>
                      <NativeSelect
                        aria-label={t("Appearance", "外观")}
                        value={data.settings.theme}
                        onChange={(e) =>
                          void save({
                            theme: e.target.value as Settings["theme"],
                          })
                            .then(() => onSuccess(t("Saved", "已保存")))
                            .catch((e) =>
                              onError(systemText(String(e), language)),
                            )
                        }
                      >
                        <NativeSelectOption value="light">
                          {t("Light", "浅色")}
                        </NativeSelectOption>
                        <NativeSelectOption value="dark">
                          {t("Dark", "深色")}
                        </NativeSelectOption>
                        <NativeSelectOption value="system">
                          {t("System", "跟随系统")}
                        </NativeSelectOption>
                      </NativeSelect>
                    </Item>
                  </ItemGroup>
                </section>
                <section className="settings-section">
                  <h2 data-slot="settings-section-title" className="settings-section-heading">
                    {t("Local data", "本地数据")}
                    <TooltipIconButton
                      aria-label={t("About local data", "关于本地数据")}
                      tooltip={t(
                        "History and encrypted credentials are stored on this device. Model requests are sent to your provider.",
                        "历史与加密凭据保存在本机。模型请求会发送至所选供应商。",
                      )}
                      side="top"
                    >
                      <Info />
                    </TooltipIconButton>
                  </h2>
                  <ItemGroup className="settings-list">
                    {(
                      [
                        ["root", t("Data directory", "数据目录")],
                        ["runtime", t("Working directory", "运行目录")],
                        ["sessions", t("Conversation history", "会话历史")],
                        ["userData", t("Settings & credentials", "设置与凭据")],
                      ] as const
                    ).map(([which, label]) => (
                      <Item size="sm" role="listitem" className="settings-entry" key={which}>
                        <ItemContent className="settings-entry-copy">
                          <ItemTitle className="settings-entry-title">{label}</ItemTitle>
                          <ItemDescription className="settings-entry-description settings-path">
                            {data.paths[which]}
                          </ItemDescription>
                        </ItemContent>
                        <Hint content={t("Open folder", "打开文件夹")}><Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t("Open ", "打开") + label}

                          onClick={() =>
                            void api
                              .invoke("showPath", { which })
                              .catch((e) =>
                                onError(systemText(String(e), language)),
                              )
                          }
                        >
                          <FolderOpen />
                        </Button></Hint>
                      </Item>
                    ))}
                  </ItemGroup>
                  {data.diagnostics.map((message, index) => (
                    <p className="model-test-result failed" key={index}>
                      {systemText(message, language)}
                    </p>
                  ))}
                </section>
                <section className="settings-section">
                  <h2 data-slot="settings-section-title">
                    {t("About", "关于")}
                  </h2>
                  <ItemGroup className="settings-list">
                    <Item size="sm" role="listitem" className="settings-entry">
                      <ItemContent className="settings-entry-copy">
                        <ItemTitle className="settings-entry-title">WorkLens</ItemTitle>
                        <ItemDescription className="settings-entry-description">
                          {t("Version", "版本")} {data.version}
                        </ItemDescription>
                      </ItemContent>
                    </Item>
                  </ItemGroup>
                </section>
              </>
            )}
          </div>
        </div>
      </div>
      {connect && (
        <ProviderDialog
          key={connect.id}
          provider={connect}
          onError={onError}
          onClose={() => setConnect(undefined)}
          onSaved={async () => {
            const next = await refresh();
            const model = next.providers
              .find((p) => p.id === connect.id)
              ?.models.find((m) => m.available);
            if (!next.settings.defaults && model)
              await save({
                defaults: {
                  provider: connect.id,
                  model: model.id,
                  thinking: model.levels.includes("medium")
                    ? "medium"
                    : model.levels[0],
                },
              });
            onSuccess(t("Connection saved", "连接已保存"));
            setConnect(undefined);
          }}
        />
      )}
      <Dialog
        open={!!remove}
        onOpenChange={(open) => {
          if (!open && !removing) setRemove(undefined);
        }}
      >
        <DialogContent className="settings-dialog">
          <DialogHeader>
            <DialogTitle>
              {t("Disconnect ", "断开连接 ")}
              {remove?.name}?
            </DialogTitle>
            <DialogDescription>
              {t("Remove the saved credential for ", "删除已保存的凭据：")}
              {remove && methodName(remove)}
              {t(". Your conversations will be kept.", "。会话记录会保留。")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={removing}
              onClick={() => setRemove(undefined)}
            >
              {t("Cancel", "取消")}
            </Button>
            <Button
              variant="destructive"
              disabled={removing}
              onClick={async () => {
                if (!remove) return;
                setRemoving(true);
                try {
                  await api.invoke("logout", { provider: remove.id });
                  await refresh();
                  setRemove(undefined);
                  onSuccess(t("Provider disconnected", "已断开连接"));
                } catch (e) {
                  onError(systemText(String(e), language));
                } finally {
                  setRemoving(false);
                }
              }}
            >
              {t("Disconnect", "断开连接")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
