import { useId, type ComponentProps } from "react";
import { Tabs } from "@base-ui/react/tabs";
import { useAppTranslation } from "@/i18n";
import { ConnectionsSettings } from "./connectors/ConnectionsSettings";
import { McpSettings } from "./McpSettings";
import { connectorCatalog } from "./connectors/catalog";

export type ConnectionTab = "builtin" | "mcp";

export function ConnectorSettingsTabs({
  tab,
  onTabChange,
  onMcpChange,
  ...props
}: ComponentProps<typeof ConnectionsSettings> & {
  tab: ConnectionTab;
  onTabChange: (tab: ConnectionTab) => void;
  onMcpChange: ComponentProps<typeof McpSettings>["onMcpChange"];
}) {
  const { t } = useAppTranslation();
  const countId = useId();
  const builtinCount = connectorCatalog.filter(
    (entry) => !!entry.connection?.(props.data)?.url,
  ).length;
  const mcpCount = props.data.mcp?.servers.length ?? 0;
  return (
    <Tabs.Root
      value={tab}
      onValueChange={(value) => {
        if (value === "builtin" || value === "mcp") onTabChange(value);
      }}
    >
      <Tabs.List
        className="settings-connector-tabs"
        aria-label={t("connectors.connectionTypes")}
        activateOnFocus
      >
        <Tabs.Tab
          value="builtin"
          data-slot="settings-connector-tab"
          aria-describedby={`${countId}-builtin`}
        >
          {t("connectors.builtIn")}
          <span className="settings-group-count" aria-hidden="true">
            {builtinCount}
          </span>
        </Tabs.Tab>
        <Tabs.Tab
          value="mcp"
          data-slot="settings-connector-tab"
          aria-describedby={`${countId}-mcp`}
        >
          {t("settings.mcp")}
          <span className="settings-group-count" aria-hidden="true">
            {mcpCount}
          </span>
        </Tabs.Tab>
      </Tabs.List>
      <span id={`${countId}-builtin`} className="sr-only">
        {t("connectors.connectionCount", { count: builtinCount })}
      </span>
      <span id={`${countId}-mcp`} className="sr-only">
        {t("connectors.connectionCount", { count: mcpCount })}
      </span>
      <Tabs.Panel value="builtin" keepMounted>
        <ConnectionsSettings {...props} />
      </Tabs.Panel>
      <Tabs.Panel value="mcp" keepMounted>
        <McpSettings
          data={props.data}
          onMcpChange={onMcpChange}
          onSuccess={props.onSuccess}
        />
      </Tabs.Panel>
    </Tabs.Root>
  );
}
