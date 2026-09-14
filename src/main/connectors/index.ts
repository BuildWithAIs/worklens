import { join } from "node:path";
import type { Encryption } from "../storage";
import type { LocalArtifacts } from "../local-artifacts";
import { ConfluenceConnections } from "./confluence/connection";
import { ConfluenceService } from "./confluence/service";
import { confluenceConnector } from "./confluence";
import { ConnectorRegistry } from "./registry";
import { connectorRequests } from "./ipc";

/** Explicit composition; no dynamic loading, dependency container or plugin system. */
export function createConnectors(
  userData: string,
  encryption: Encryption,
  artifacts: LocalArtifacts,
) {
  const connections = new ConfluenceConnections(
    join(userData, "confluence.json"),
    encryption,
  );
  const confluence = new ConfluenceService(connections, artifacts);
  return {
    registry: new ConnectorRegistry([confluenceConnector(confluence)]),
    requests: connectorRequests(confluence),
    bootstrap: () => ({ confluence: connections.info() }),
  };
}
