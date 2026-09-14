import { useState } from "react";
import { SearchInput } from "./SearchInput";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import github from "@lobehub/icons-static-svg/icons/github.svg?url";
import jira from "@/assets/brands/jira.svg?url";
import confluence from "@/assets/brands/confluence.svg?url";
import { BrandIcon } from "./ProviderIcon";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Item, ItemGroup, ItemContent, ItemTitle, ItemActions } from "@/components/ui/item";
import { useLocale } from "@/lib/locale";

// Presentation only. Authentication and connection state belong to the future integration API.
export function ConnectionsSettings() {
  const { t } = useLocale();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("all");
  const platforms = [
    { id: "jira", name: "Jira", icon: jira },
    { id: "confluence", name: "Confluence", icon: confluence },
    { id: "github", name: "GitHub", icon: github },
  ];
  const search = query.trim().toLocaleLowerCase();
  const filtered = platforms.filter(platform =>
    `${platform.name} ${platform.id === "github" ? "" : "Atlassian"}`.toLocaleLowerCase().includes(search),
  );
  // Until the connection API is available, the catalog contains no connected accounts.
  const available = scope === "connected" ? [] : filtered;
  return (
    <>
      <div className="settings-toolbar">
        <SearchInput aria-label={t("Search connectors", "搜索连接器")} placeholder={t("Search connectors…", "搜索连接器…")} value={query} onValueChange={setQuery} />
        <NativeSelect aria-label={t("Filter connectors", "筛选连接器")} value={scope} onChange={event => setScope(event.target.value)}>
          <NativeSelectOption value="all">{t("All connectors", "全部连接器")}</NativeSelectOption>
          <NativeSelectOption value="connected">{t("Connected", "已连接")}</NativeSelectOption>
          <NativeSelectOption value="available">{t("Available", "可连接")}</NativeSelectOption>
        </NativeSelect>
      </div>
      {!!available.length && <section className="settings-section">
      <h2 data-slot="settings-section-title" className="settings-group-bar">{t("Available", "可连接")}<span className="settings-group-count" aria-hidden="true">{available.length}</span></h2>
      <ItemGroup className="settings-list settings-connection-list">
        {available.map(({ id, name, icon }) => (
          <Item key={id} size="sm" role="listitem" className="settings-entry" data-connection={id}>
            <ItemContent className="settings-entry-copy">
              <ItemTitle className="settings-entry-title"><BrandIcon source={icon} />{name}</ItemTitle>
            </ItemContent>
            <ItemActions className="settings-entry-actions">
                <Button variant="outline" size="sm" disabled aria-label={`${t("Connect", "连接")} ${name}`}>
                  <Plus data-icon="inline-start" aria-hidden="true" />{t("Connect", "连接")}
                </Button>
            </ItemActions>
          </Item>
        ))}
      </ItemGroup>
    </section>}
      {!available.length && <p className="settings-empty">{scope === "connected" && !search
        ? t("No connections yet.", "暂无已连接的平台。")
        : t("No connectors match your filters.", "没有匹配的连接器。")}</p>}
    </>
  );
}
