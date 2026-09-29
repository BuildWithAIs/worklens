import { join } from "node:path";
import type { Encryption } from "../storage";
import type { LocalArtifacts } from "../local-artifacts";
import { ConfluenceConnections } from "./confluence/connection";
import { ConfluenceService } from "./confluence/service";
import { confluenceConnector } from "./confluence";
import { ConnectorRegistry } from "./registry";
import { JiraConnections } from "./jira/connection";
import { JiraService } from "./jira/service";
import { jiraConnector } from "./jira";
import { connectorRequests } from "./ipc";
import { GitHubConnections } from "./github/connection";
import { GitHubService } from "./github/service";
import { githubConnector } from "./github";
import { TavilyConnections } from "./tavily/connection";
import { TavilyService } from "./tavily/service";
import { tavilyConnector } from "./tavily";
import { JevConnections } from "./jev/connection";
import { JevConsent } from "./jev/consent";
import { JevService } from "./jev/service";
import { jevConnector } from "./jev";

/** Explicit composition; no dynamic loading, dependency container or plugin system. */
export function createConnectors(
  userData: string,
  encryption: Encryption,
  artifacts: LocalArtifacts,
  options: {
    redact?: (text: string) => string;
    onConsentChange?: (sessionId: string) => void;
  } = {},
) {
  const connections = new ConfluenceConnections(
    join(userData, "confluence.json"),
    encryption,
  );
  const confluence = new ConfluenceService(connections, artifacts);
  const jiraConnections = new JiraConnections(
    join(userData, "jira.json"),
    encryption,
  );
  const jira = new JiraService(jiraConnections, artifacts);
  const githubConnections = new GitHubConnections(
    join(userData, "github.json"),
    encryption,
  );
  const github = new GitHubService(githubConnections, artifacts);
  const tavilyConnections = new TavilyConnections(
    join(userData, "tavily.json"),
    encryption,
  );
  const tavily = new TavilyService(tavilyConnections, artifacts);
  const jevConnections = new JevConnections(
    join(userData, "jev.json"),
    encryption,
  );
  const jevConsent = new JevConsent(
    join(userData, "jev-consent.json"),
    options.onConsentChange,
    () => jevConnections.consentRevision(),
  );
  const jev: JevService = new JevService(
    jevConnections,
    jevConsent,
    (text): string => {
      const clean = registry.redact(text);
      return options.redact ? options.redact(clean) : clean;
    },
  );
  const registry: ConnectorRegistry = new ConnectorRegistry([
    confluenceConnector(confluence),
    jiraConnector(jira),
    githubConnector(github),
    tavilyConnector(tavily),
    jevConnector(jev),
  ]);
  return {
    registry,
    jevConsent,
    requests: connectorRequests(confluence, jira, github, tavily, jev),
    bootstrap: () => ({
      confluence: connections.info(),
      jira: jiraConnections.info(),
      github: githubConnections.info(),
      tavily: tavilyConnections.info(),
      jev: jevConnections.info(),
    }),
  };
}
