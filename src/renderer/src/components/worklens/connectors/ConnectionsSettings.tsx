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
import { useAppTranslation } from "@/i18n";
import { connectorCatalog, type ConnectorSettingsProps } from "./catalog";
export function ConnectionsSettings({
  data,
  refresh,
  onSuccess,
}: Omit<ConnectorSettingsProps, "onClose">) {
  const { t } = useAppTranslation();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("all");
  const [editing, setEditing] = useState<string>();
  const Settings = connectorCatalog.find(
    (entry) => entry.id === editing,
  )?.Settings;
  const search = query.trim().toLocaleLowerCase();
  const groups = [
    { id: "connected", label: t("common.connected"), connected: true },
    { id: "available", label: t("common.available"), connected: false },
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
          aria-label={t("connectors.searchConnectors")}
          placeholder={t("connectors.searchConnectorsPlaceholder")}
          value={query}
          onValueChange={setQuery}
        />
        <NativeSelect
          aria-label={t("connectors.filterConnectors")}
          value={scope}
          onChange={(event) => setScope(event.target.value)}
        >
          <NativeSelectOption value="all">
            {t("connectors.allConnectors")}
          </NativeSelectOption>
          <NativeSelectOption value="connected">
            {t("common.connected")}
          </NativeSelectOption>
          <NativeSelectOption value="available">
            {t("common.available")}
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
                    aria-label={`${group.connected ? t("common.manage") : t("common.connect")} ${name}`}
                  >
                    {group.connected ? (
                      <Settings2 data-icon="inline-start" aria-hidden="true" />
                    ) : (
                      <Plus data-icon="inline-start" aria-hidden="true" />
                    )}
                    {group.connected ? t("common.manage") : t("common.connect")}
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
            ? t("connectors.noConnectionsYet")
            : t("connectors.noConnectorsMatchYourFilters")}
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
