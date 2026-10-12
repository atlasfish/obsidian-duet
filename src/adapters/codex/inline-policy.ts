export type InlineShellApproval = 'ask' | 'yolo';

/** Optional tools for a Codex mention. Commands run through Duet's configured command tool. */
export interface InlineToolPolicy {
  webSearch: boolean;
  shell: boolean;
  shellApproval?: InlineShellApproval;
  /** Exact tool names, grouped by a server configured in Codex's config.toml. */
  mcpTools: Record<string, string[]>;
}

export interface CodexToolConfig {
  mcp_servers?: Record<string, { enabled?: boolean; enabled_tools?: string[]; [key: string]: unknown }>;
  plugins?: Record<string, { [key: string]: unknown }>;
}

/** Let Codex enforce the MCP allow list; disable alternate command and plugin entry points. */
export function inlineConfig(policy: InlineToolPolicy, config: CodexToolConfig): Record<string, unknown> {
  const overrides: Record<string, unknown> = {
    web_search: policy.webSearch ? 'live' : 'disabled',
    'features.shell_tool': false,
    'features.unified_exec': false,
    'features.js_repl': false,
    'features.apps': false,
    'features.skill_mcp_dependency_install': false,
    approvals_reviewer: 'user',
  };
  const servers = config.mcp_servers ?? {};
  for (const server of Object.keys(policy.mcpTools)) {
    if (!Object.hasOwn(servers, server)) throw new Error(`Inline MCP server ${server} is not configured in Codex.`);
    if (servers[server]!.enabled === false) throw new Error(`Inline MCP server ${server} is disabled in Codex.`);
  }
  const filteredServers: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [server, settings] of Object.entries(servers)) {
    const selected = policy.mcpTools[server] ?? [];
    const tools = settings.enabled_tools
      ? selected.filter((tool) => settings.enabled_tools!.includes(tool))
      : selected;
    filteredServers[server] = { ...tomlValues(settings), enabled: tools.length > 0, ...(tools.length && { enabled_tools: tools }) };
  }
  overrides.mcp_servers = filteredServers;
  // Plugin-provided servers and connectors are outside the configured-server allow list.
  overrides.plugins = Object.fromEntries(Object.entries(config.plugins ?? {}).map(([name, settings]) => [name, { ...tomlValues(settings), enabled: false }]));
  return overrides;
}

/** config/read uses null for unset options; TOML overrides cannot represent null. */
function tomlValues(settings: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(settings).filter(([, value]) => value != null).map(([key, value]) => [
    key, typeof value === 'object' && !Array.isArray(value) ? tomlValues(value as Record<string, unknown>) : value,
  ]));
}
