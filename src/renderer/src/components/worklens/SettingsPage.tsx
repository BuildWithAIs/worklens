import { settingsFailure } from "./settings-notification";
import { DisconnectConfirmation } from "./DisconnectConfirmation";
import { toast } from "@/components/ui/toast";
import { BackgroundEffect } from "./BackgroundEffect";
import { BackgroundPreferences } from "./BackgroundPreferences";
import { ConnectionsSettings } from "./connectors/ConnectionsSettings";
import { SkillsSettings } from "./skills/SkillsSettings";
import { Hint } from "@/components/ui/tooltip";
import { ProviderIcon } from "./ProviderIcon";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Plug,
  Cpu,
  ArrowUpRight,
  Info,
  Globe,
  LoaderCircle,
  Plus,
  RefreshCw,
  Settings2,
  Sparkles,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import {
  Item,
  ItemGroup,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemActions,
} from "@/components/ui/item";
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

import { systemText } from "@/lib/system-text";
import { languageTag, useAppTranslation } from "@/i18n";
import type {
  Bootstrap,
  ProviderInfo,
  Settings,
} from "../../../../shared/contracts";
import "./settings.css";

export type SettingsSection =
  | "general"
  | "providers"
  | "models"
  | "connections"
  | "skills";
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
  initialSection = "general",
  save,
  refresh,
  onBack,
  onError,
  onSuccess,
}: Props) {
  const { t, i18n, language } = useAppTranslation();
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
  const providerFailure = useCallback(
    (message: string, action: "login" | "save" | "browser") => {
      toast.add(
        settingsFailure(
          t(`settingsFeedback.${action}Failed`, {
            service: connect?.name ?? "",
          }),
          message,
          language,
        ),
      );
    },
    [connect?.name, t, language],
  );
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
        id ? t("settings.modelsRefreshed") : t("settings.providersRefreshed"),
      );
    } catch (e) {
      toast.add(
        settingsFailure(
          t("settingsFeedback.refreshFailed", {
            service: t(id ? "settings.models" : "settings.providers"),
          }),
          String(e),
          language,
        ),
      );
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
        onSuccess(t("settingsFeedback.visibilitySaved"));
      } catch (e) {
        const rollback = new Set(hiddenRef.current);
        confirmedHidden.current.has(key)
          ? rollback.add(key)
          : rollback.delete(key);
        hiddenRef.current = rollback;
        setHiddenModels(rollback);
        toast.add(
          settingsFailure(
            t("settingsFeedback.visibilityFailed"),
            String(e),
            language,
          ),
        );
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
    try {
      await api.invoke("test", {
        provider: provider.id,
        model: model.id,
        thinking: model.levels.includes("medium") ? "medium" : model.levels[0],
      });
      onSuccess(t("settingsFeedback.modelConnected", { service: model.name }));
    } catch (e) {
      toast.add(
        settingsFailure(
          t("connectors.notice.testFailed", { service: model.name }),
          String(e),
          language,
        ),
      );
    } finally {
      setTesting((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }
  const filtered = data.providers.filter((p) => {
    const isConnected = Boolean(
      p.configured || p.credentialType || p.credentialError,
    );
    return (
      (p.name + " " + p.id).toLowerCase().includes(query.toLowerCase()) &&
      (providerScope === "all" ||
        (providerScope === "connected" ? isConnected : !isConnected))
    );
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
      ? t("settings.systemCredentials")
      : t("settings.notConnected"));
  const nav = [
    { id: "general" as const, label: t("settings.general"), icon: Settings2 },
    { id: "providers" as const, label: t("settings.providers"), icon: Globe },
    { id: "models" as const, label: t("settings.models"), icon: Cpu },
    { id: "connections" as const, label: t("settings.connectors"), icon: Plug },
    { id: "skills" as const, label: t("settings.skills"), icon: Sparkles },
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
                  {t("settings.savedCredentialsNeedAttention")}
                </ItemDescription>
              )}
            </ItemContent>
            <ItemActions className="settings-entry-actions">
              {isConnected ? (
                <>
                  {(p.methods.some((m) => m.interactive) ||
                    p.credentialType ||
                    p.credentialError) && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => openConnect(p)}
                    >
                      <Settings2 data-icon="inline-start" aria-hidden="true" />
                      {t("common.manage")}
                    </Button>
                  )}
                </>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => openConnect(p)}
                >
                  <Plus data-icon="inline-start" />
                  {t("common.connect")}
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
        <BackgroundEffect settings={data.settings} />
        <Button variant="ghost" className="settings-back" onClick={onBack}>
          <ArrowLeft />
          {t("settings.backToApp")}
        </Button>
        <nav aria-label={t("settings.settingsSections")}>
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
        <BackgroundEffect settings={data.settings} edge />
        <header className="settings-page-heading">
          <h1 data-slot="settings-page-title">
            {nav.find((n) => n.id === section)?.label}
          </h1>
        </header>
        <div className="settings-scroll">
          <div className="settings-page-content" data-section={section}>
            {section === "providers" && (
              <>
                <div className="settings-toolbar">
                  <SearchInput
                    aria-label={t("settings.searchProviders")}
                    placeholder={t("settings.searchProvidersPlaceholder")}
                    value={query}
                    onValueChange={setQuery}
                  />
                  <NativeSelect
                    aria-label={t("settings.filterProviders")}
                    value={providerScope}
                    onChange={(event) => setProviderScope(event.target.value)}
                  >
                    <NativeSelectOption value="all">
                      {t("settings.allProviders")}
                    </NativeSelectOption>
                    <NativeSelectOption value="connected">
                      {t("common.connected")}
                    </NativeSelectOption>
                    <NativeSelectOption value="available">
                      {t("common.available")}
                    </NativeSelectOption>
                  </NativeSelect>
                  <TooltipIconButton
                    variant="ghost"
                    className="size-[38px] p-0"
                    size="icon"
                    aria-label={t("settings.refreshProviders")}
                    tooltip={t("settings.refreshProviders")}
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
                    <h2
                      data-slot="settings-section-title"
                      className="settings-group-bar"
                    >
                      {t("common.connected")}
                      <span className="settings-group-count" aria-hidden="true">
                        {connected.length}
                      </span>
                    </h2>
                    {providerRows(connected, true)}
                  </section>
                )}
                {!!others.length && (
                  <section className="settings-section">
                    <h2
                      data-slot="settings-section-title"
                      className="settings-group-bar"
                    >
                      {t("common.available")}
                      <span className="settings-group-count" aria-hidden="true">
                        {others.length}
                      </span>
                    </h2>
                    {providerRows(others, false)}
                  </section>
                )}
                {!filtered.length && (
                  <p className="settings-empty">
                    {t("settings.noProvidersMatchYourFilters")}
                  </p>
                )}
              </>
            )}
            {section === "models" && (
              <>
                <div className="settings-toolbar">
                  <SearchInput
                    aria-label={t("settings.searchModels")}
                    placeholder={t(
                      "settings.searchModelsOrProvidersPlaceholder",
                    )}
                    value={modelQuery}
                    onValueChange={(value) => {
                      setModelQuery(value);
                      setExpanded({});
                      setLimits({});
                    }}
                  />
                  <NativeSelect
                    aria-label={t("settings.modelFilter")}
                    value={scope}
                    onChange={(e) => setScope(e.target.value)}
                  >
                    <NativeSelectOption value="all">
                      {t("settings.allModels")}
                    </NativeSelectOption>
                    <NativeSelectOption value="connected">
                      {t("common.connected")}
                    </NativeSelectOption>
                    <NativeSelectOption value="visible">
                      {t("settings.shownInChat")}
                    </NativeSelectOption>
                  </NativeSelect>
                </div>
                <Accordion
                  multiple
                  value={modelGroups
                    .filter(
                      (p) =>
                        expanded[p.id] ?? (!!modelQuery.trim() || p.configured),
                    )
                    .map((p) => p.id)}
                  onValueChange={(values) =>
                    setExpanded((prev) => ({
                      ...prev,
                      ...Object.fromEntries(
                        modelGroups.map((p) => [p.id, values.includes(p.id)]),
                      ),
                    }))
                  }
                >
                  {modelGroups.map((p) => (
                    <AccordionItem value={p.id} key={p.id}>
                      <div className="settings-accordion-heading settings-group-bar">
                        <AccordionTrigger>
                          <span className="flex items-center gap-2">
                            <ProviderIcon provider={p.id} />
                            <span data-slot="model-provider-name">
                              {p.name}
                            </span>
                            <span className="settings-group-count">
                              {p.models.length}
                            </span>
                          </span>
                        </AccordionTrigger>
                        {!p.configured && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="shrink-0"
                            aria-label={t("settings.goToProvidersFor", {
                              provider: p.name,
                            })}
                            onClick={() => goToProviders(p)}
                          >
                            {t("settings.goToProviders")}
                          </Button>
                        )}
                        <TooltipIconButton
                          variant="ghost"
                          className="size-8 p-0"
                          size="icon-sm"
                          aria-label={t("settings.refreshModelsFor", {
                            provider: p.name,
                          })}
                          tooltip={t("settings.refreshModels")}
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
                                  <Hint
                                    content={t(
                                      "settings.contextWindowAndCapabilities",
                                    )}
                                  >
                                    <div
                                      className="settings-entry-description"
                                      tabIndex={0}
                                    >
                                      {Intl.NumberFormat(
                                        languageTag(language),
                                        {
                                          notation: "compact",
                                          maximumFractionDigits: 1,
                                        },
                                      ).format(m.contextWindow)}
                                      {m.reasoning
                                        ? t("settings.thinkingSuffix")
                                        : ""}
                                      {m.image
                                        ? t("settings.visionSuffix")
                                        : ""}
                                    </div>
                                  </Hint>
                                </div>
                                <div className="settings-entry-actions">
                                  {m.available ? (
                                    <>
                                      <TooltipIconButton
                                        variant="ghost"
                                        size="icon-xs"
                                        disabled={testing.has(key)}
                                        aria-label={t(
                                          "settings.testConnectionFor",
                                          { model: m.name },
                                        )}
                                        tooltip={t(
                                          "settings.testConnectionSendsAShortRequest",
                                        )}
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
                                          <TooltipTrigger
                                            render={
                                              <Switch
                                                size="sm"
                                                aria-label={t(
                                                  "settings.showInChatFor",
                                                  {
                                                    model: m.name,
                                                  },
                                                )}
                                                checked={!hiddenModels.has(key)}
                                                disabled={pendingVisibility.has(
                                                  key,
                                                )}
                                                onCheckedChange={(checked) =>
                                                  void toggleModel(key, checked)
                                                }
                                              />
                                            }
                                          />
                                          <TooltipContent side="bottom">
                                            {t("settings.showInChat")}
                                          </TooltipContent>
                                        </Tooltip>
                                      </TooltipProvider>
                                    </>
                                  ) : p.configured ? (
                                    <Hint
                                      content={t(
                                        "settings.unavailableModelHint",
                                      )}
                                    >
                                      <span
                                        className="text-xs text-muted-foreground"
                                        tabIndex={0}
                                      >
                                        {t("common.unavailable")}
                                      </span>
                                    </Hint>
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
                            {t("settings.showMoreModels")}
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
                          {t("settings.noProvidersConnected")}
                        </p>
                        <p className="mt-2">
                          {t("settings.emptyProvidersDescription")}
                        </p>
                        <Button
                          variant="outline"
                          className="mt-4"
                          onClick={() => goToProviders()}
                        >
                          {t("settings.goToProviders")}
                        </Button>
                      </>
                    ) : (
                      <p>{t("settings.emptyModels")}</p>
                    )}
                  </div>
                )}
              </>
            )}
            {section === "connections" && (
              <ConnectionsSettings
                data={data}
                refresh={refresh}
                onSuccess={onSuccess}
              />
            )}
            {section === "skills" && <SkillsSettings onSuccess={onSuccess} />}
            {section === "general" && (
              <>
                <section className="settings-section">
                  <h2
                    data-slot="settings-section-title"
                    className="settings-group-bar"
                  >
                    {t("settings.preferences")}
                  </h2>
                  <ItemGroup className="settings-list">
                    <Item size="sm" role="listitem" className="settings-entry">
                      <ItemContent className="settings-entry-copy">
                        <ItemTitle className="settings-entry-title">
                          {t("settings.language")}
                        </ItemTitle>
                      </ItemContent>
                      <NativeSelect
                        aria-label={t("settings.language")}
                        value={language}
                        onChange={(e) => {
                          const next = e.target.value as "en" | "zh";
                          void i18n
                            .changeLanguage(next)
                            .catch(() =>
                              onError(i18n.t("settings.couldNotSaveLanguage")),
                            );
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
                        {t("settings.appearance")}
                      </ItemTitle>
                      <NativeSelect
                        aria-label={t("settings.appearance")}
                        value={data.settings.theme}
                        onChange={(e) =>
                          void save({
                            theme: e.target.value as Settings["theme"],
                          }).catch((e) =>
                            onError(systemText(String(e), language)),
                          )
                        }
                      >
                        <NativeSelectOption value="light">
                          {t("settings.light")}
                        </NativeSelectOption>
                        <NativeSelectOption value="dark">
                          {t("settings.dark")}
                        </NativeSelectOption>
                        <NativeSelectOption value="system">
                          {t("settings.system")}
                        </NativeSelectOption>
                      </NativeSelect>
                    </Item>
                    <BackgroundPreferences
                      settings={data.settings}
                      save={save}
                      onError={onError}
                    />
                  </ItemGroup>
                </section>
                <section className="settings-section">
                  <h2
                    data-slot="settings-section-title"
                    className="settings-section-heading settings-group-bar"
                  >
                    {t("settings.localData")}
                    <Hint content={t("settings.localDataDescription")}>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="size-5"
                        aria-label={t("settings.aboutLocalData")}
                      >
                        <Info aria-hidden="true" />
                      </Button>
                    </Hint>
                  </h2>
                  <ItemGroup className="settings-list">
                    {(
                      [
                        ["root", t("settings.dataDirectory")],
                        ["runtime", t("settings.runtimeDirectory")],
                        ["sessions", t("settings.conversationHistory")],
                        ["userData", t("settings.settingsCredentials")],
                        ["skills", t("settings.skillsDirectory")],
                      ] as const
                    ).map(([which, label]) => (
                      <Item
                        size="sm"
                        role="listitem"
                        className="settings-entry"
                        key={which}
                      >
                        <ItemContent className="settings-entry-copy">
                          <ItemTitle className="settings-entry-title">
                            {label}
                          </ItemTitle>
                          <ItemDescription className="settings-entry-description">
                            <Hint
                              content={
                                <span className="break-all">
                                  {data.paths[which]}
                                </span>
                              }
                            >
                              <span
                                className="settings-path"
                                tabIndex={0}
                                aria-label={data.paths[which]}
                              >
                                <bdi dir="ltr">{data.paths[which]}</bdi>
                              </span>
                            </Hint>
                          </ItemDescription>
                        </ItemContent>
                        <Hint content={t("settings.openFolder")}>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t("settings.openLabel", { label })}
                            onClick={() =>
                              void api
                                .invoke("showPath", { which })
                                .catch((e) =>
                                  onError(systemText(String(e), language)),
                                )
                            }
                          >
                            <ArrowUpRight strokeWidth={1.75} />
                          </Button>
                        </Hint>
                      </Item>
                    ))}
                  </ItemGroup>
                  {data.diagnostics.map((message, index) => (
                    <p className="model-test-result failed" key={index}>
                      {systemText(message, language)}
                    </p>
                  ))}
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
          onDisconnect={
            connect.credentialType || connect.credentialError
              ? () => setRemove(connect)
              : undefined
          }
          disconnecting={removing}
          onError={providerFailure}
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
            onSuccess(t("settingsFeedback.saved", { service: connect.name }));
            setConnect(undefined);
          }}
        />
      )}
      <DisconnectConfirmation
        open={!!remove}
        busy={removing}
        title={t("settings.disconnectProvider", {
          provider: remove?.name ?? "",
        })}
        description={t("settings.removeCredentialDescription", {
          method: remove ? methodName(remove) : "",
        })}
        onCancel={() => setRemove(undefined)}
        onConfirm={async () => {
          if (!remove) return;
          setRemoving(true);
          try {
            await api.invoke("logout", { provider: remove.id });
            await refresh();
            setRemove(undefined);
            setConnect(undefined);
            onSuccess(
              t("settingsFeedback.disconnected", { service: remove.name }),
            );
          } catch (e) {
            toast.add(
              settingsFailure(
                t("connectors.notice.removeFailed", {
                  service: remove.name,
                }),
                String(e),
                language,
              ),
            );
          } finally {
            setRemoving(false);
          }
        }}
      />
    </div>
  );
}
