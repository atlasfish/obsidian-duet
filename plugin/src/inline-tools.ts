import { createHash } from 'node:crypto';
import type { InlineToolPolicy } from '../../src/index.ts';
import type { AgentProfile } from './settings.ts';

/** One exact server/tool per line. Blank lines are ignored; wildcards are not supported. */
export function parseInlineMcpTools(text: string): Record<string, string[]> {
  const servers = Object.create(null) as Record<string, string[]>;
  for (const line of text.split('\n').map((line) => line.trim()).filter(Boolean)) {
    const match = /^([^\s/*]+)\/([^\s/*]+)$/.exec(line);
    if (!match) throw new Error(`Use one exact server/tool per line: ${line}`);
    const server = match[1]!;
    const tool = match[2]!;
    const tools = (servers[server] ??= []);
    if (!tools.includes(tool)) tools.push(tool);
  }
  return servers;
}

export function inlinePolicy(profile: AgentProfile): InlineToolPolicy | undefined {
  if (profile.harness !== 'codex' || !profile.inlineToolsEnabled) return undefined;
  return { webSearch: profile.inlineWebSearch, shell: profile.inlineShell, shellApproval: profile.inlineShellApproval ?? 'ask', mcpTools: parseInlineMcpTools(profile.inlineMcpTools) };
}

/** Different tool sets must never resume a thread with the previous tool declarations. */
export function inlineSessionKey(profile: AgentProfile): string {
  const policy = inlinePolicy(profile);
  if (!policy) return profile.name;
  const digest = createHash('sha256').update(JSON.stringify(policy)).digest('hex').slice(0, 16);
  return `${profile.name}#inline-${digest}`;
}

