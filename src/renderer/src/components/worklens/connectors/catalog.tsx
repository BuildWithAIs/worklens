import type { ComponentType } from "react";
import type { Bootstrap } from "../../../../../shared/contracts";
import github from "@lobehub/icons-static-svg/icons/github.svg?url";
import jira from "@/assets/brands/jira.svg?url";
import confluence from "@/assets/brands/confluence.svg?url";
import { JiraSettings } from "./jira/JiraSettings";
import { ConfluenceSettings } from "./confluence/ConfluenceSettings";

export interface ConnectorSettingsProps {
  data: Bootstrap;
  refresh: () => Promise<unknown>;
  onSuccess: (message: string) => void;
  onClose: () => void;
}
interface CatalogEntry {
  id: string;
  name: string;
  icon: string;
  keywords?: string;
  connection?: (
    data: Bootstrap,
  ) => { configured: boolean; url?: string } | undefined;
  Settings?: ComponentType<ConnectorSettingsProps>;
}
function ConfluenceConfiguration({ data, ...props }: ConnectorSettingsProps) {
  return <ConfluenceSettings connection={data.confluence} {...props} />;
}
// UI-only registration. Never import main-process clients or credentials here.
export const connectorCatalog: readonly CatalogEntry[] = [
  {
    id: "jira",
    name: "Jira",
    icon: jira,
    keywords: "Atlassian",
    connection: (data) => data.jira,
    Settings: ({ data, ...props }) => (
      <JiraSettings connection={data.jira} {...props} />
    ),
  },
  {
    id: "confluence",
    name: "Confluence",
    icon: confluence,
    keywords: "Atlassian",
    connection: (data) => data.confluence,
    Settings: ConfluenceConfiguration,
  },
  { id: "github", name: "GitHub", icon: github },
];
