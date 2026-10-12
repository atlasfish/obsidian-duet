import { describe, expect, it } from 'vitest';
import { inlineConfig } from '../../src/adapters/codex/inline-policy.ts';

describe('Codex inline tool policy', () => {
  it('removes unselected servers and plugins, and cannot bypass a configured allow list', () => {
    const config = inlineConfig({ webSearch: true, shell: true, mcpTools: { logs: ['read', 'delete'] } }, {
      mcp_servers: { logs: { enabled_tools: ['read'], tool_timeout_sec: null }, mail: {} }, plugins: { 'browser@bundled': {} },
    });
    expect((config.mcp_servers as Record<string, Record<string, unknown>>).logs).not.toHaveProperty('tool_timeout_sec');
    expect(config).toMatchObject({
      web_search: 'live', 'features.shell_tool': false, 'features.unified_exec': false,
      'features.js_repl': false, 'features.apps': false,
      mcp_servers: { logs: { enabled: true, enabled_tools: ['read'] }, mail: { enabled: false } },
      plugins: { 'browser@bundled': { enabled: false } },
    });
  });

  it('turns off search and every configured MCP server for an empty policy', () => {
    expect(inlineConfig({ webSearch: false, shell: false, mcpTools: {} }, { mcp_servers: { logs: {} } }))
      .toMatchObject({ web_search: 'disabled', mcp_servers: { logs: { enabled: false } } });
  });

  it('rejects unknown and disabled servers instead of silently inheriting tools', () => {
    const policy = { webSearch: false, shell: false, mcpTools: { logs: ['read'] } };
    expect(() => inlineConfig(policy, {})).toThrow('not configured');
    expect(() => inlineConfig(policy, { mcp_servers: { logs: { enabled: false } } })).toThrow('disabled');
  });
});
