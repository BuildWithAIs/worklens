import { useState } from "react";
import { SearchInput } from "../SearchInput";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { BrandIcon, ProviderIcon } from "../ProviderIcon";
import { CircleAlert, Plus, Settings2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
import {
  connectorCatalog,
  savedConnections,
  type ConnectorInstance,
  type ConnectorSettingsProps,
} from "./catalog";
export function ConnectionsSettings({
  data,
  refresh,
  onSuccess,
  conversation,
  onConsentChange,
}: Omit<ConnectorSettingsProps, "onClose">) {
  const { t } = useAppTranslation();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("all");
  const [editing, setEditing] = useState<{ id: string; instance?: string }>();
  const Settings = connectorCatalog.find(
    (entry) => entry.id === editing?.id,
  )?.Settings;
  const search = query.trim().toLocaleLowerCase();
  const matches = (text: string) => text.toLocaleLowerCase().includes(search);
  const rows = connectorCatalog.flatMap((platform) => {
    const saved = savedConnections(platform, data);
    const label = `${platform.name} ${platform.keywords ?? ""}`;
    return [
      ...saved
        .filter((instance) => matches(`${label} ${instance.url ?? ""}`))
        .map((instance) => ({
          platform,
          added: true,
          instance: instance as ConnectorInstance | undefined,
          // Several saved sites need their address to tell actions apart.
          multiple: saved.length > 1,
        })),
      // Multi-instance services stay available for adding another site.
      ...((!saved.length || platform.instances) && matches(label)
        ? [
            {
              platform,
              added: false,
              instance: undefined,
              multiple: saved.length > 0,
            },
          ]
        : []),
    ];
  });
  const groups = [
    { id: "connected", label: t("common.connected"), added: true },
    { id: "available", label: t("common.available"), added: false },
  ]
    .map((group) => ({
      ...group,
      platforms: rows.filter((row) => row.added === group.added),
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
            {group.platforms.map(({ platform, instance, multiple }) => {
              const { id, name, icon, tagline, Settings } = platform;
              const adding = !group.added && multiple;
              const label = group.added
                ? `${t("common.manage")} ${name}${multiple && instance?.url ? ` ${instance.url}` : ""}`
                : adding
                  ? t("connectors.addSiteNamed", { name })
                  : `${t("common.connect")} ${name}`;
              return (
                <Item
                  key={`${id}:${instance?.id ?? ""}`}
                  size="sm"
                  role="listitem"
                  className="settings-entry"
                  data-connection={id}
                  data-connection-instance={instance?.id}
                >
                  <ItemContent className="settings-entry-copy">
                    <ItemTitle className="settings-entry-title">
                      {icon ? <BrandIcon source={icon} /> : <ProviderIcon />}
                      <span>{name}</span>
                      {tagline && <Badge variant="outline">{tagline(t)}</Badge>}
                      {instance?.readOnly && (
                        <Badge variant="outline">
                          {t("connectors.readOnly")}
                        </Badge>
                      )}
                    </ItemTitle>
                    {instance?.error && (
                      <ItemDescription className="text-[var(--warning)]">
                        <span className="inline-flex items-center gap-1.5">
                          <CircleAlert
                            className="size-3.5 shrink-0"
                            aria-hidden="true"
                          />
                          {t("settingsFeedback.connectionNeedsAttention")}
                        </span>
                      </ItemDescription>
                    )}
                    {group.added && (
                      <ItemDescription className="settings-entry-description">
                        {instance?.url}
                      </ItemDescription>
                    )}
                  </ItemContent>
                  <ItemActions className="settings-entry-actions">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!Settings}
                      onClick={() =>
                        setEditing({
                          id,
                          // Single-connection services have no instance ID.
                          instance:
                            instance && instance.id !== id
                              ? instance.id
                              : undefined,
                        })
                      }
                      aria-label={label}
                    >
                      {group.added ? (
                        <Settings2
                          data-icon="inline-start"
                          aria-hidden="true"
                        />
                      ) : (
                        <Plus data-icon="inline-start" aria-hidden="true" />
                      )}
                      {group.added
                        ? t("common.manage")
                        : adding
                          ? t("connectors.addSite")
                          : t("common.connect")}
                    </Button>
                  </ItemActions>
                </Item>
              );
            })}
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
          // Each site keeps its own form state.
          key={`${editing?.id}:${editing?.instance ?? ""}`}
          data={data}
          conversation={conversation}
          onConsentChange={onConsentChange}
          refresh={refresh}
          onSuccess={onSuccess}
          instance={editing?.instance}
          onClose={() => setEditing(undefined)}
        />
      )}
    </>
  );
}
