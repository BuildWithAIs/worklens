import { useState } from "react";
import { SearchInput } from "../SearchInput";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { BrandIcon } from "../ProviderIcon";
import { Plus, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemGroup,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemActions,
} from "@/components/ui/item";
import { useLocale } from "@/lib/locale";
import { connectorCatalog, type ConnectorSettingsProps } from "./catalog";
export function ConnectionsSettings({
  data,
  refresh,
  onSuccess,
}: Omit<ConnectorSettingsProps, "onClose">) {
  const { t } = useLocale();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("all");
  const [editing, setEditing] = useState<string>();
  const Settings = connectorCatalog.find(
    (entry) => entry.id === editing,
  )?.Settings;
  const search = query.trim().toLocaleLowerCase();
  const groups = [
    { id: "connected", label: t("Connected", "已连接"), connected: true },
    { id: "available", label: t("Available", "可连接"), connected: false },
  ]
    .map((group) => ({
      ...group,
      platforms: connectorCatalog.filter((platform) => {
        const configured = !!platform.connection?.(data)?.configured;
        return (
          configured === group.connected &&
          `${platform.name} ${platform.keywords ?? ""}`
            .toLocaleLowerCase()
            .includes(search)
        );
      }),
    }))
    .filter(
      (group) =>
        group.platforms.length && (scope === "all" || scope === group.id),
    );
  return (
    <>
      <div className="settings-toolbar">
        <SearchInput
          aria-label={t("Search connectors", "搜索连接器")}
          placeholder={t("Search connectors…", "搜索连接器…")}
          value={query}
          onValueChange={setQuery}
        />
        <NativeSelect
          aria-label={t("Filter connectors", "筛选连接器")}
          value={scope}
          onChange={(event) => setScope(event.target.value)}
        >
          <NativeSelectOption value="all">
            {t("All connectors", "全部连接器")}
          </NativeSelectOption>
          <NativeSelectOption value="connected">
            {t("Connected", "已连接")}
          </NativeSelectOption>
          <NativeSelectOption value="available">
            {t("Available", "可连接")}
          </NativeSelectOption>
        </NativeSelect>
      </div>
      {groups.map((group) => (
        <section className="settings-section" key={group.id}>
          <h2 data-slot="settings-section-title" className="settings-group-bar">
            {group.label}
            <span className="settings-group-count" aria-hidden="true">
              {group.platforms.length}
            </span>
          </h2>
          <ItemGroup className="settings-list settings-connection-list">
            {group.platforms.map(({ id, name, icon, connection, Settings }) => (
              <Item
                key={id}
                size="sm"
                role="listitem"
                className="settings-entry"
                data-connection={id}
              >
                <ItemContent className="settings-entry-copy">
                  <ItemTitle className="settings-entry-title">
                    <BrandIcon source={icon} />
                    {name}
                  </ItemTitle>
                  {group.connected && (
                    <ItemDescription className="settings-entry-description">
                      {connection?.(data)?.url}
                    </ItemDescription>
                  )}
                </ItemContent>
                <ItemActions className="settings-entry-actions">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!Settings}
                    onClick={() => setEditing(id)}
                    aria-label={`${group.connected ? t("Manage", "管理") : t("Connect", "连接")} ${name}`}
                  >
                    {group.connected ? (
                      <Settings2 data-icon="inline-start" aria-hidden="true" />
                    ) : (
                      <Plus data-icon="inline-start" aria-hidden="true" />
                    )}
                    {group.connected
                      ? t("Manage", "管理")
                      : t("Connect", "连接")}
                  </Button>
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        </section>
      ))}
      {!groups.length && (
        <p className="settings-empty">
          {scope === "connected" && !search
            ? t("No connections yet.", "暂无已连接的平台。")
            : t("No connectors match your filters.", "没有匹配的连接器。")}
        </p>
      )}
      {Settings && (
        <Settings
          data={data}
          refresh={refresh}
          onSuccess={onSuccess}
          onClose={() => setEditing(undefined)}
        />
      )}
    </>
  );
}
