// The editor only changes fields it owns. Keep provider authentication, custom
// headers, environment variables and tool exposure settings from imported JSON.
export interface McpConnectionConfig {
  displayName?: string;
  description?: string;
  url?: string;
  command?: string;
  args?: string[];
  enabled?: boolean;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  cwd?: string;
  oauth?: { clientId?: string; clientSecret?: string };
  auth?: { provider: string };
  [key: string]: unknown;
}

export type McpTestResult =
  | { state: "untested" | "testing" | "signIn" }
  | { state: "passed"; tools: number }
  | { state: "failed"; error: string };

export function mcpDisplayName(id: string, config?: McpConnectionConfig) {
  return config?.displayName ?? id;
}

export interface McpConfiguration {
  mcpServers: Record<string, McpConnectionConfig>;
}

type McpImportResult =
  | { servers: Record<string, McpConnectionConfig> }
  | {
      error:
        | "configurationInvalid"
        | "importNamesInvalid"
        | "importNameConflict"
        | "importLimit";
      name?: string;
    };

export function parseMcpImport(
  raw: string,
  existingNames: string[],
): McpImportResult {
  let configuration: McpConfiguration;
  try {
    configuration = readMcpConfiguration(raw);
    if (Object.keys(configuration).some((key) => key !== "mcpServers"))
      return { error: "configurationInvalid" };
  } catch {
    return { error: "configurationInvalid" };
  }
  const entries = Object.entries(configuration.mcpServers);
  if (
    !entries.length ||
    entries.some(
      ([, entry]) =>
        !entry || typeof entry !== "object" || Array.isArray(entry),
    )
  )
    return { error: "configurationInvalid" };
  if (existingNames.length + entries.length > 100)
    return { error: "importLimit" };
  const namespaces = new Set(
    existingNames.map((name) => name.replaceAll("-", "_")),
  );
  for (const [name] of entries) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(name))
      return { error: "importNamesInvalid" };
    const namespace = name.replaceAll("-", "_");
    if (namespaces.has(namespace)) return { error: "importNameConflict", name };
    namespaces.add(namespace);
  }
  return { servers: configuration.mcpServers };
}

export function readMcpConfiguration(raw?: string): McpConfiguration {
  const value: unknown = JSON.parse(raw ?? '{"mcpServers":{}}');
  if (
    !value ||
    typeof value !== "object" ||
    !("mcpServers" in value) ||
    !value.mcpServers ||
    typeof value.mcpServers !== "object" ||
    Array.isArray(value.mcpServers)
  )
    throw new Error("Invalid MCP configuration");
  return value as McpConfiguration;
}

export function mcpEndpoint(config?: McpConnectionConfig) {
  if (!config?.url) return "";
  try {
    const url = new URL(config.url);
    // Authentication can be embedded in query parameters. Never copy those
    // parameters into connection rows or tooltips.
    return url.host + url.pathname;
  } catch {
    return "";
  }
}

// Match the main process's credential reuse rules without relaxing them.
export function requiredMcpCredentials(
  next: McpConnectionConfig,
  previous?: McpConnectionConfig,
): string[] {
  let sameTarget = false;
  if (previous) {
    if (next.url && previous.url) {
      try {
        sameTarget = new URL(next.url).href === new URL(previous.url).href;
      } catch {
        /* URL validation owns this error. */
      }
    } else if (!next.url && !previous.url) {
      sameTarget =
        JSON.stringify([next.command, next.args, next.cwd]) ===
        JSON.stringify([previous.command, previous.args, previous.cwd]);
    }
  }
  const field = next.url ? "headers" : "env";
  const required = Object.entries(next[field] ?? {})
    .filter(
      ([key, value]) =>
        value === "<saved>" &&
        (!sameTarget || !Object.hasOwn(previous?.[field] ?? {}, key)),
    )
    .map(([key]) => `${field}.${key}`);
  if (
    next.url &&
    next.oauth?.clientSecret === "<saved>" &&
    (!sameTarget ||
      !previous?.oauth?.clientSecret ||
      previous.oauth.clientId !== next.oauth.clientId)
  )
    required.push("oauth.clientSecret");
  return required;
}
