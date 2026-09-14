import { z } from "zod";
import type { Requests } from "../../shared/contracts";
import { connectionSchema } from "./confluence/connection";
import type { ConfluenceService } from "./confluence/service";

import { connectionSchema as jiraSchema } from "./jira/connection";
import type { JiraService } from "./jira/service";
import { connectionSchema as githubSchema } from "./github/connection";
import type { GitHubService } from "./github/service";

// Each connector owns its settings schema; the IPC surface remains explicit and typed.
export const connectorSchemas = {
  githubSave: githubSchema,
  githubTest: githubSchema,
  githubRemove: z.undefined(),
  jiraSave: jiraSchema,
  jiraTest: jiraSchema,
  jiraRemove: z.undefined(),
  confluenceSave: connectionSchema,
  confluenceTest: connectionSchema,
  confluenceRemove: z.undefined(),
};
type ConnectorRequest = keyof typeof connectorSchemas;
export function isConnectorRequest(
  method: keyof Requests,
): method is ConnectorRequest {
  return Object.hasOwn(connectorSchemas, method);
}
export function connectorRequests(
  confluence: ConfluenceService,
  jira: JiraService,
  github: GitHubService,
) {
  const handlers: {
    [K in ConnectorRequest]: (
      input: Requests[K]["input"],
    ) => Promise<Requests[K]["output"]>;
  } = {
    githubSave: (input) => github.connections.save(input),
    githubTest: (input) => github.test(input),
    githubRemove: () => github.connections.remove(),
    jiraSave: (input) => jira.connections.save(input),
    jiraTest: (input) => jira.test(input),
    jiraRemove: () => jira.connections.remove(),
    confluenceSave: (input) => confluence.connections.save(input),
    confluenceTest: (input) => confluence.test(input),
    confluenceRemove: () => confluence.connections.remove(),
  };
  return <K extends ConnectorRequest>(
    method: K,
    input: Requests[K]["input"],
  ): Promise<Requests[K]["output"]> => handlers[method](input);
}
