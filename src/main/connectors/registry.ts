import type { Connector } from "./types";

export class ConnectorRegistry {
  constructor(private readonly connectors: readonly Connector[] = []) {
    const ids = connectors.map((connector) => connector.id);
    if (new Set(ids).size !== ids.length)
      throw new Error("Duplicate connector ID");
  }
  async initialize() {
    await Promise.all(
      this.connectors.map((connector) => connector.initialize()),
    );
  }
  configurationKey() {
    return JSON.stringify(
      this.connectors.map((connector) => [
        connector.id,
        connector.configurationKey(),
      ]),
    );
  }
  names() {
    return this.connectors.flatMap((connector) => connector.names());
  }
  tools(sessionId: string, runId: () => string) {
    return this.connectors.flatMap((connector) =>
      connector.tools(sessionId, runId),
    );
  }
  instructions() {
    return this.connectors
      .filter((connector) => connector.names().length > 0)
      .map((connector) => connector.instructions)
      .join("\n");
  }
  redact(text: string) {
    return this.connectors.reduce(
      (value, connector) => connector.redact(value),
      text,
    );
  }
}
