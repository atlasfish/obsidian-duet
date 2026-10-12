import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { findCodexExecutable, startCodexSession, type CodexSessionOptions } from 'yami/agent/codex';
import { harnessEnvironment } from './environment.ts';
import { inlineConfig, type CodexToolConfig, type InlineToolPolicy } from './inline-policy.ts';

/** Reads the effective configuration through Codex, including the vault's configuration layers. */
export function readCodexToolConfig(executable: string, cwd: string, env: Record<string, string>): Promise<CodexToolConfig> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['app-server', '--stdio'], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], timeout: 15_000 });
    const lines = createInterface({ input: child.stdout });
    const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + '\n');
    child.once('error', reject);
    child.stdin.on('error', reject);
    child.once('close', (code) => {
      lines.close();
      reject(new Error(`Codex closed before returning its tool configuration (exit ${code}).`));
    });
    lines.on('line', (line) => {
      let response: { id?: number; error?: { message: string }; result?: { config: CodexToolConfig } };
      try { response = JSON.parse(line) as typeof response; } catch { return; }
      if (response.error) { reject(new Error(response.error.message)); child.stdin.end(); return; }
      if (response.id === 1) {
        send({ method: 'initialized' });
        send({ id: 2, method: 'config/read', params: { includeLayers: false, cwd } });
      } else if (response.id === 2) {
        if (response.result?.config) resolve(response.result.config);
        else reject(new Error('Codex returned no tool configuration.'));
        child.stdin.end();
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'duet-policy', title: 'Duet tool policy', version: '0.6.0' }, capabilities: null } });
  });
}

/** Only override tool-selection leaves; Codex retains transport, credentials and disabled_tools. */
export function inlineConfigArgs(policy: InlineToolPolicy, config: CodexToolConfig): string[] {
  const selected = inlineConfig(policy, config);
  const args = Object.entries(selected).filter(([key]) => key !== 'mcp_servers' && key !== 'plugins')
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  for (const [server, settings] of Object.entries(selected.mcp_servers as NonNullable<CodexToolConfig['mcp_servers']>)) {
    const prefix = `mcp_servers.${JSON.stringify(server)}`;
    args.push(`${prefix}.enabled=${settings.enabled}`);
    if (settings.enabled_tools) args.push(`${prefix}.enabled_tools=${JSON.stringify(settings.enabled_tools)}`);
  }
  for (const name of Object.keys(selected.plugins as NonNullable<CodexToolConfig['plugins']>)) {
    args.push(`plugins.${JSON.stringify(name)}.enabled=false`);
  }
  return args;
}

export async function startInlineCodexSession(options: CodexSessionOptions, policy: InlineToolPolicy) {
  const env = await harnessEnvironment(options.env);
  const executablePath = options.executablePath ?? findCodexExecutable(env);
  const config = await readCodexToolConfig(executablePath, options.cwd, env);
  return startCodexSession({ ...options, executablePath, env,
    config: [...(options.config ?? []), ...inlineConfigArgs(policy, config)],
    webSearch: policy.webSearch ? 'live' : 'disabled',
  });
}
