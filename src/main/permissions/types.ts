import type {
  PermissionCode,
  PermissionScope,
  PermissionDetails,
  PermissionExecutionTarget,
} from "../../shared/permissions";
export type Json = PermissionDetails;
export interface FileResource {
  path: string;
  identity: string;
  ancestors: { path: string; identity: string }[];
}
export type OperationEffect =
  | {
      kind:
        | "file.read"
        | "file.list"
        | "file.create"
        | "file.modify"
        | "file.delete";
      target: FileResource;
    }
  | { kind: "network.connect"; host: string; port: number }
  | {
      kind: "service.read" | "service.mutate";
      connectionId: string;
      revision: string;
      resource: string;
      action: string;
    }
  | { kind: "data.send"; receiver: string; contentHash: string; bytes: number }
  | { kind: "process.execute"; target: "vm" | "host-srt"; workspaceId: string }
  | {
      kind: "mcp.start" | "mcp.call";
      serverId: string;
      generation: string;
      definitionHash: string;
      argumentsHash: string;
    };
export interface InvocationContext {
  readonly id: string;
  readonly executionId: string;
  readonly parentToolCallId?: string;
  readonly conversationId: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly parentInvocationId?: string;
  readonly origin: "agent" | "user-ui" | "internal";
  readonly epoch: string;
  readonly signal: AbortSignal;
}
export interface PolicyDependency {
  readonly kind: "rule" | "grant" | "execution";
  readonly id: string;
  readonly version: string;
}
export interface OperationPlan {
  readonly dependencies: readonly PolicyDependency[];
  readonly id: string;
  readonly invocation: InvocationContext;
  readonly tool: string;
  readonly summary: string;
  readonly payloadHash: string;
  readonly bindingHash: string;
  readonly effects: readonly OperationEffect[];
  readonly expectedTargets: Json;
  readonly connectionRevision?: string;
  readonly policyRevision: string;
  readonly executionTarget: PermissionExecutionTarget;
  readonly expiresAt: number;
  readonly review: Json;
  readonly payload: Json;
}
export interface OperationInput {
  tool: string;
  summary: string;
  /** Main-built, secret-free approval details; never the raw execution payload. */
  review: Json;
  payload: Json;
  effects: OperationEffect[];
  expectedTargets: Json;
  connectionRevision?: string;
  executionTarget: PermissionExecutionTarget;
}
export interface ReadRule {
  id: string;
  conversationId: string;
  path: string;
  identity: string;
  subtree: boolean;
  actions: ("file.read" | "file.list")[];
  enabled: boolean;
}
export interface PolicySettings {
  protectedPaths: string[];
  deniedPaths: string[];
  /** Verified adapters must revalidate target identities at their final commit point. */
  readRules: ReadRule[];
  fileBoundary: boolean;
  backends: { vm: boolean; hostSrt: boolean };
  execution?: {
    conversationId: string;
    runId: string;
    target: "vm" | "host-srt";
    workspaceId: string;
    revision: string;
    grantId: string;
  };
}
export type PolicyDecision =
  | { kind: "deny"; code: PermissionCode }
  | { kind: "allow" }
  | { kind: "ask"; scopes: PermissionScope[] };
export class PermissionError extends Error {
  constructor(readonly code: PermissionCode) {
    super(code);
    this.name = "PermissionError";
  }
}
