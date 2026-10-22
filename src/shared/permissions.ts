export type PermissionExecutionTarget = "trusted-main" | "vm" | "host-srt";
export type PermissionDetails =
  | null
  | boolean
  | number
  | string
  | PermissionDetails[]
  | { [key: string]: PermissionDetails };
export type PermissionCode =
  | "PERMISSION_DENIED"
  | "PERMISSION_EXPIRED"
  | "PERMISSION_STALE"
  | "PERMISSION_STORE_UNAVAILABLE"
  | "PERMISSION_AUDIT_UNAVAILABLE"
  | "CAPABILITY_UNSUPPORTED"
  | "PERMISSION_CAPACITY_EXCEEDED"
  | "SIDE_EFFECT_UNKNOWN";
export type PermissionState =
  | "awaiting_approval"
  | "approved"
  | "reserved"
  | "executing"
  | "completed"
  | "rejected"
  | "expired"
  | "cancelled"
  | "invalidated"
  | "failed"
  | "partial"
  | "unknown";
export type PermissionScope = "once" | "task";
export interface PermissionApprovalView {
  id: string;
  operationId: string;
  conversationId: string;
  runId: string;
  toolCallId: string;
  tool: string;
  summary: string;
  details: PermissionDetails;
  payloadHash: string;
  policyRevision: string;
  executionTarget: PermissionExecutionTarget;
  expiresAt: number;
  scopes: PermissionScope[];
  state: PermissionState;
}
export interface PermissionGrantView {
  id: string;
  scope: PermissionScope;
  operationId: string;
  expiresAt?: number;
  runId: string;
  kind: "operation" | "execution";
}
export interface PermissionRuleView {
  id: string;
  enabled: boolean;
}
export interface PermissionSnapshot {
  conversationId: string;
  runId?: string;
  revision: string;
  /** P1 is infrastructure; tool enforcement is connected in P2/P3. */
  enforcement: "not-connected";
  backends: { vm: false; hostSrt: false; fileBoundary: false };
  error?: PermissionCode;
  pending: PermissionApprovalView[];
  grants: PermissionGrantView[];
  rules: PermissionRuleView[];
}
export interface PermissionEvent {
  runId?: string;
  sequence: number;
  conversationId: string;
  operationId?: string;
  state?: PermissionState;
  revision: string;
  auditPending?: boolean;
}
export interface PermissionRequests {
  permissionsGet: {
    input: { conversationId: string };
    output: PermissionSnapshot;
  };
  permissionReply: {
    input: {
      conversationId: string;
      requestId: string;
      decision: "allow" | "deny";
      scope: PermissionScope;
    };
    output: PermissionSnapshot;
  };
  permissionRevoke: {
    input: { conversationId: string; grantId: string };
    output: PermissionSnapshot;
  };
  permissionRulesUpdate: {
    input: {
      conversationId: string;
      expectedRevision: string;
      updates: { ruleId: string; enabled: boolean }[];
    };
    output: PermissionSnapshot;
  };
  permissionSelectFiles: {
    input: { conversationId: string; intent: "read" | "write" };
    output: PermissionSnapshot;
  };
}
