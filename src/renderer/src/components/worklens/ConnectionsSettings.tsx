import { useState } from "react";
import { SearchInput } from "./SearchInput";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import github from "@lobehub/icons-static-svg/icons/github.svg?url";
import jira from "@/assets/brands/jira.svg?url";
import confluence from "@/assets/brands/confluence.svg?url";
import { BrandIcon } from "./ProviderIcon";
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
import { ConfluenceSettings } from "./ConfluenceSettings";
import type { ConfluenceConnection } from "../../../../shared/contracts";

const platforms = [
  { id: "jira", name: "Jira", icon: jira },
  { id: "confluence", name: "Confluence", icon: confluence },
  { id: "github", name: "GitHub", icon: github },
];
export function ConnectionsSettings({
  connection,
  refresh,
  onSuccess,
}: {
  connection?: ConfluenceConnection;
  refresh: () => Promise<unknown>;
  onSuccess: (message: string) => void;
}) {
  const { t } = useLocale();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("all");
  const [editing, setEditing] = useState(false);
  const search = query.trim().toLocaleLowerCase();
  const groups = [
    { id: "connected", label: t("Connected", "已连接"), connected: true },
    { id: "available", label: t("Available", "可连接"), connected: false },
  ]
    .map((group) => ({
      ...group,
      platforms: platforms.filter((platform) => {
        const configured =
          platform.id === "confluence" && !!connection?.configured;
        return (
          configured === group.connected &&
          `${platform.name} ${platform.id === "github" ? "" : "Atlassian"}`
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
            {group.platforms.map(({ id, name, icon }) => (
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
                      {connection?.url}
                    </ItemDescription>
                  )}
                </ItemContent>
                <ItemActions className="settings-entry-actions">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={id !== "confluence"}
                    onClick={() => setEditing(true)}
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
      {editing && (
        <ConfluenceSettings
          connection={connection}
          refresh={refresh}
          onSuccess={onSuccess}
          onClose={() => setEditing(false)}
        />
      )}
    </>
  );
}
