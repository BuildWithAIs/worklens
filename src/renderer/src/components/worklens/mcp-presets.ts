// Official remote endpoints, checked 2026-10-03. Presets are form defaults,
// not a claim that WorkLens has been approved by or tested with each service.
export const mcpPresets = [
  {
    id: "atlassian",
    url: "https://mcp.atlassian.com/v2/mcp",
    guide:
      "https://developer.atlassian.com/cloud/rovo-mcp/guides/getting-started/",
  },
  {
    id: "notion",
    url: "https://mcp.notion.com/mcp",
    guide: "https://developers.notion.com/guides/mcp/get-started-with-mcp",
  },
  {
    id: "linear",
    url: "https://mcp.linear.app/mcp",
    guide: "https://linear.app/docs/mcp",
  },
  {
    id: "github",
    url: "https://api.githubcopilot.com/mcp/",
    guide: "https://github.com/github/github-mcp-server",
  },
  {
    id: "sentry",
    url: "https://mcp.sentry.dev/mcp",
    guide: "https://mcp.sentry.dev/",
  },
] as const;

export type McpPresetId = (typeof mcpPresets)[number]["id"];

export function availableMcpName(base: string, names: string[]) {
  const used = new Set(names.map((name) => name.replaceAll("-", "_")));
  let name = base;
  for (let suffix = 2; used.has(name.replaceAll("-", "_")); suffix++)
    name = `${base}-${suffix}`;
  return name;
}
