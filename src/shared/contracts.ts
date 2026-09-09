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
  credentialError?: string;
  methods: { type: "api_key" | "oauth"; name: string; interactive: boolean }[];
  models: ModelInfo[];
  connection?: { ok: boolean; message: string; checkedAt: string };
}
export interface Settings {
  version: 1;
  theme: "light" | "dark" | "system";
  riskAccepted: boolean;
  defaults?: Selection;
  lastConversation?: string;
  [key: string]: unknown;
}
export interface MessageView {
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
}
export interface ChatEvent {
  conversationId: string;
  runId: string;
  sequence: number;
  type: string;
  view: ConversationView;
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
