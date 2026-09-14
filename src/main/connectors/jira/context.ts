import { createHash } from "node:crypto";
import { join } from "node:path";
import { Continuations } from "./continuations";
import { JiraConnections, type ConnectionSnapshot } from "./connection";
import type { LocalArtifacts } from "../../local-artifacts";
import { JiraAdapter } from "./adapter";
import type { Json } from "./http";
export interface Execution {
  connections: JiraConnections;
  connection: ConnectionSnapshot;
  adapter: JiraAdapter;
  artifacts: LocalArtifacts;
  sessionId: string;
  signal: AbortSignal;
  cursors: Continuations;
}
export function scope(ctx: Execution, request: Json) {
  const { continuation: _, ...rest } = request;
  return {
    sessionId: ctx.sessionId,
    revision: ctx.connection.revision,
    scope: createHash("sha256").update(JSON.stringify(rest)).digest("hex"),
  };
}
export function cursors(artifacts: LocalArtifacts) {
  return new Continuations(join(artifacts.root, "jira"));
}
