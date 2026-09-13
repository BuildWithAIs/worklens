export type Thinking =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";
export type Phase =
  | "idle"
  | "generating"
  | "tool"
  | "compacting"
  | "retrying"
  | "stopping"
  | "completed"
  | "cancelled"
  | "failed";
export interface Selection {
  provider: string;
  model: string;
  thinking: Thinking;
}
export type UsageDataStatus = "complete" | "partial" | "unavailable";
export type CostSource =
  | "provider"
  | "pi-estimate"
  | "calculated"
  | "mixed"
  | "unknown";
export interface CostUsage {
  status: UsageDataStatus;
  usd?: number;
  source: CostSource;
}
export interface TokenUsage {
  status: UsageDataStatus;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  total?: number;
  cost: CostUsage;
}
export interface GlobalUsage {
  status: UsageDataStatus;
  totalTokens?: number;
  scope: "retained-local-sessions";
  sessionCount: number;
  readableSessionCount: number;
  unavailableSessionCount: number;
  /** Monotonic within this main-process lifetime; never a billing ledger ID. */
  revision: number;
}
export interface ContextUsage {
  status: UsageDataStatus;
  tokens?: number;
  contextWindow?: number;
  percent?: number;
}
export interface RunUsage extends TokenUsage {
  runId: string;
  state: "active" | "completed" | "cancelled" | "failed" | "incomplete";
  selection?: Selection;
  startedAt?: string;
  endedAt?: string;
  elapsedMs?: number;
}
export interface UsageSnapshot {
  run?: RunUsage;
  conversation: TokenUsage;
  context?: ContextUsage;
}
export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  image: boolean;
  contextWindow: number;
  levels: Thinking[];
  available: boolean;
}
export interface ProviderInfo {
  id: string;
  name: string;
  configured: boolean;
  credentialType?: "api_key" | "oauth";
  credentialHint?: string;
  credentialError?: string;
  methods: { type: "api_key" | "oauth"; name: string; interactive: boolean }[];
  models: ModelInfo[];
  connection?: { ok: boolean; message: string; checkedAt: string };
}
export interface Settings {
  version: 1;
  theme: "light" | "dark" | "system";
  backgroundEffect?: "none" | "surface" | "fluid";
  backgroundTone?: "violet" | "electric" | "ice";
  riskAccepted: boolean;
  defaults?: Selection;
  hiddenModels?: string[];
  lastConversation?: string;
  pinnedConversationIds?: string[];
  [key: string]: unknown;
}
export interface MessageView {
  artifacts?: LocalArtifact[];
  createdAt?: string;
  runStartedAt?: string;
  runElapsedMs?: number;
  id: string;
  role: "user" | "assistant" | "tool" | "summary";
  text: string;
  thinking?: string;
  toolId?: string;
  toolName?: string;
  args?: string;
  targetPath?: string;
  shellCwd?: string;
  timeoutSeconds?: number;
  exitCode?: number | null;
  startedAt?: string;
  status?:
    | "pending"
    | "waiting"
    | "running"
    | "success"
    | "error"
    | "timeout"
    | "cancelled";
  elapsed?: number;
  error?: string;
}
export interface Conversation {
  id: string;
  title: string;
  updatedAt: string;
  selection?: Selection;
  phase: Phase;
  runId?: string;
  error?: string;
  statusDetail?: string;
  revision?: number;
}
export interface ConversationView extends Conversation {
  messages: MessageView[];
  usage?: UsageSnapshot;
}
export interface ChatEvent {
  conversationId: string;
  runId: string;
  sequence: number;
  type: string;
  view: ConversationView;
  globalUsage?: GlobalUsage;
}
export interface AuthStep {
  loginId: string;
  promptId?: string;
  type: string;
  message?: string;
  url?: string;
  userCode?: string;
  options?: { id: string; label: string; description?: string }[];
  placeholder?: string;
}
export interface Recovery {
  runId: string;
  conversationId: string;
  text: string;
  selection: Selection;
  startedAt: string;
}
export interface Bootstrap {
  confluence?: ConfluenceConnection;
  globalUsage?: GlobalUsage;
  settings: Settings;
  providers: ProviderInfo[];
  conversations: Conversation[];
  paths: { root: string; runtime: string; sessions: string; userData: string };
  version: string;
  tools: string[];
  diagnostics: string[];
  recoveries: Recovery[];
}
export interface Requests {
  htmlFileAction: { input: { id: string; path?: string; code?: string; action: "chrome" | "reveal" }; output: void };
  previewHtml: { input: { id: string; path: string }; output: string };
  confluenceSave: {
    input: ConfluenceSettingsInput;
    output: ConfluenceConnection;
  };
  confluenceTest: { input: ConfluenceSettingsInput; output: string };
  confluenceRemove: { input: undefined; output: void };
  artifact: {
    input: { id: string; action: "show" | "open" | "saveAs" };
    output: void;
  };
  bootstrap: { input: undefined; output: Bootstrap };
  settings: { input: Partial<Settings>; output: Settings };
  providers: { input: undefined; output: ProviderInfo[] };
  login: {
    input: { provider: string; type: "api_key" | "oauth"; loginId: string };
    output: void;
  };
  authReply: {
    input: { loginId: string; promptId: string; value: string };
    output: void;
  };
  authCancel: { input: { loginId: string }; output: void };
  logout: { input: { provider: string }; output: void };
  azure: {
    input: {
      baseUrl: string;
      resource: string;
      apiVersion: string;
      deployments: string;
    };
    output: void;
  };
  test: { input: Selection; output: string };
  clearConnection: { input: { provider: string }; output: void };
  open: { input: { id: string }; output: ConversationView };
  rename: { input: { id: string; title: string }; output: void };
  delete: { input: { id: string }; output: void };
  send: {
    input: {
      conversationId?: string;
      requestId: string;
      text: string;
      selection: Selection;
    };
    output: ConversationView;
  };
  cancel: { input: { conversationId: string; runId: string }; output: void };
  model: {
    input: { id: string; selection: Selection };
    output: ConversationView;
  };
  external: { input: { url: string }; output: void };
  dismissRecovery: { input: { runId: string }; output: void };
  refreshModels: { input: { provider: string }; output: string };
  showPath: {
    input: { which: "root" | "runtime" | "sessions" | "userData" };
    output: void;
  };
}
export interface ConfluenceSettingsInput {
  url: string;
  deployment: "data-center" | "cloud";
  email?: string;
  token?: string;
  cloudId?: string;
  tokenType: "classic" | "scoped";
  access: "read" | "confirm" | "write";
}
export interface ConfluenceConnection extends Omit<
  ConfluenceSettingsInput,
  "token"
> {
  configured: boolean;
  error?: string;
}
export interface LocalArtifact {
  id: string;
  name: string;
  path: string;
  size: number;
}
export interface WorkLensAPI {
  invoke<K extends keyof Requests>(
    method: K,
    input: Requests[K]["input"],
  ): Promise<Requests[K]["output"]>;
  onChat(listener: (event: ChatEvent) => void): () => void;
  onAuth(listener: (event: AuthStep) => void): () => void;
}
declare global {
  interface Window {
    worklens: WorkLensAPI;
  }
}
