import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/** Only the integration surface needed by the current Agent runtime. */
export interface Connector {
  readonly id: string;
  readonly instructions: string;
  initialize(): Promise<void>;
  configurationKey(): string;
  names(): string[];
  tools(sessionId: string, runId: () => string): ToolDefinition[];
  redact(text: string): string;
}
