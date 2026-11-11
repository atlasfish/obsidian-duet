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
    let config: CodexToolConfig | undefined;
    const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + '\n');
    child.once('error', reject);
    child.stdin.on('error', reject);
    child.once('close', (code) => {
      lines.close();
      if (config) resolve(config);
      else reject(new Error(`Codex closed before returning its tool configuration (exit ${code}).`));
    });
    lines.on('line', (line) => {
      let response: { id?: number; error?: { message: string }; result?: { config: CodexToolConfig } };
      try { response = JSON.parse(line) as typeof response; } catch { return; }
      if (response.error) { reject(new Error(response.error.message)); child.stdin.end(); return; }
      if (response.id === 1) {
        send({ method: 'initialized' });
        send({ id: 2, method: 'config/read', params: { includeLayers: false, cwd } });
      } else if (response.id === 2) {
        if (response.result?.config) config = response.result.config;
        else reject(new Error('Codex returned no tool configuration.'));
        child.stdin.end();
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'duet-policy', title: 'Duet tool policy', version: '0.6.0' }, capabilities: null } });
  });
}

/** CLI overrides take TOML values; complete tables preserve server transports and arbitrary names. */
export function inlineConfigArgs(policy: InlineToolPolicy, config: CodexToolConfig): string[] {
  return Object.entries(inlineConfig(policy, config)).map(([key, value]) => `${key}=${inlineToml(value)}`);
}

/** Configuration API JSON scalars/arrays use JSON escaping; TOML tables use equals signs. */
function inlineToml(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(inlineToml).join(', ')}]`;
  if (value !== null && typeof value === 'object') {
    return `{ ${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)} = ${inlineToml(item)}`).join(', ')} }`;
  }
  return JSON.stringify(value);
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
