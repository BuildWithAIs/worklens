import { z } from "zod";
import type { Requests } from "../../shared/contracts";
import { connectionSchema } from "./confluence/connection";
import type { ConfluenceService } from "./confluence/service";

import { connectionSchema as jiraSchema } from "./jira/connection";
import type { JiraService } from "./jira/service";
import { connectionSchema as githubSchema } from "./github/connection";
import type { GitHubService } from "./github/service";
import { connectionSchema as tavilySchema } from "./tavily/connection";
import type { TavilyService } from "./tavily/service";
import { connectionSchema as jevSchema } from "./jev/connection";
import type { JevService } from "./jev/service";

const confluenceSiteSchema = connectionSchema.extend({
  site: z.string().min(1).max(100).optional(),
  readOnly: z.boolean().optional(),
});
// Each connector owns its settings schema; the IPC surface remains explicit and typed.
export const connectorSchemas = {
  jevSave: jevSchema,
  jevTest: jevSchema,
  jevRemove: z.undefined(),
  githubSave: githubSchema,
  githubTest: githubSchema,
  githubRemove: z.undefined(),
  tavilySave: tavilySchema,
  tavilyTest: tavilySchema,
  tavilyUsage: z
    .object({ refresh: z.boolean().optional() })
    .strict()
    .optional(),
  tavilyRemove: z.undefined(),
  jiraSave: jiraSchema,
  jiraTest: jiraSchema,
  jiraRemove: z.undefined(),
  confluenceSave: confluenceSiteSchema,
  confluenceTest: confluenceSiteSchema,
  confluenceRemove: z.object({ site: z.string().min(1).max(100) }).strict(),
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
  tavily: TavilyService,
  jev: JevService,
) {
  const handlers: {
    [K in ConnectorRequest]: (
      input: Requests[K]["input"],
    ) => Promise<Requests[K]["output"]>;
  } = {
    jevSave: (input) => jev.connections.save(input),
    jevTest: (input) => jev.connections.test(input),
    jevRemove: () => jev.connections.remove(),
    githubSave: (input) => github.connections.save(input),
    githubTest: (input) => github.test(input),
    githubRemove: () => github.connections.remove(),
    tavilySave: (input) => tavily.connections.save(input),
    tavilyTest: (input) => tavily.test(input),
    tavilyUsage: (input) => tavily.connections.usageState(input?.refresh),
    tavilyRemove: () => tavily.connections.remove(),
    jiraSave: (input) => jira.connections.save(input),
    jiraTest: (input) => jira.test(input),
    jiraRemove: () => jira.connections.remove(),
    confluenceSave: (input) => confluence.sites.save(input),
    confluenceTest: (input) => confluence.test(input),
    confluenceRemove: (input) => confluence.sites.remove(input.site),
  };
  return <K extends ConnectorRequest>(
    method: K,
    input: Requests[K]["input"],
  ): Promise<Requests[K]["output"]> => handlers[method](input);
}
