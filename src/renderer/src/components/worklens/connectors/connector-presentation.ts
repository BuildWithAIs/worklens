export type ConnectorAction = "save" | "test" | "remove";

export function connectorName(service: string) {
  return service === "github"
    ? "GitHub"
    : service === "jira"
      ? "Jira"
      : "Confluence";
}
