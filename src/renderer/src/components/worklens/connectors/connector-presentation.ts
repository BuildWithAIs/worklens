export type ConnectorAction = "save" | "test" | "remove";

const names: Record<string, string> = {
  github: "GitHub",
  jira: "Jira",
  confluence: "Confluence",
  tavily: "Tavily",
};
export function connectorName(service: string) {
  return names[service] ?? service;
}
