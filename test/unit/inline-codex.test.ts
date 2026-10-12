import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inlineConfigArgs, readCodexToolConfig, startInlineCodexSession } from '../../plugin/src/inline-codex.ts';
import type { InlineToolPolicy } from '../../plugin/src/inline-policy.ts';

const FAKE = fileURLToPath(new URL('../fixtures/fake-codex.mjs', import.meta.url));
let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'duet-yami-codex-'));
  // Node is a native executable on Windows too; its app-server entry loads the fixture.
  await writeFile(join(cwd, 'app-server'), `import(${JSON.stringify(pathToFileURL(FAKE).href)});`);
});
afterEach(async () => { await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
const policy: InlineToolPolicy = { webSearch: true, shell: true, shellApproval: 'yolo', mcpTools: { logs: ['read'] } };

describe('Yami Codex mention integration', () => {
  it('reads effective config without starting a model turn', async () => {
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    expect(await readCodexToolConfig(process.execPath, cwd, env)).toMatchObject({ mcp_servers: { logs: {}, mail: {} } });
  });

  it('overrides tool-selection leaves while preserving server transport and disabled tools', () => {
    const args = inlineConfigArgs(policy, { mcp_servers: { logs: { command: 'private-command', disabled_tools: ['delete'], enabled_tools: ['read'] }, mail: {} }, plugins: { 'browser@bundled': {} } });
    expect(args).toContain('mcp_servers."logs".enabled=true');
    expect(args).toContain('mcp_servers."logs".enabled_tools=["read"]');
    expect(args).toContain('mcp_servers."mail".enabled=false');
    expect(args).toContain('plugins."browser@bundled".enabled=false');
    expect(args.join('\n')).not.toContain('command=');
    expect(args.join('\n')).not.toContain('disabled_tools=');
  });

  it('starts and resumes Yami sessions with live search and read-only native permissions', async () => {
    const options = { cwd, clientName: 'duet-test', executablePath: process.execPath, access: 'read-only' as const };
    let session = await startInlineCodexSession(options, policy);
    try {
      const setup = JSON.parse((await session.send('setup')).text);
      expect(setup.config.web_search).toBe('live');
      expect(setup.approvalPolicy).toBe('never');
      expect(setup.permissions).toBe('yami-read-only');
      expect(setup.argv).toContain('features.shell_tool=false');
      expect(setup.argv).toContain('mcp_servers."mail".enabled=false');
      const resume = session.id;
      await session.close();
      session = await startInlineCodexSession({ ...options, resume }, policy);
      expect((await session.send('hello')).text).toBe('Hello there');
    } finally { await session.close(); }
  });
});
