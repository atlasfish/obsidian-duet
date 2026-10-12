import { chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startCodexSession, unwrapShell } from '../../src/adapters/codex/session.ts';
import { z } from 'zod';
import { type AgentEvent, type AgentSession, defineTool, type PermissionDecision, type PermissionRequest } from '../../src/index.ts';

const FAKE = fileURLToPath(new URL('../fixtures/fake-codex.mjs', import.meta.url));
chmodSync(FAKE, 0o755);

// Windows does not execute shebang scripts directly. Use the same fixture through Node.
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, spawn: (command: string, args: string[], options: import('node:child_process').SpawnOptions) =>
    command === FAKE ? original.spawn(process.execPath, [FAKE, ...args], options) : original.spawn(command, args, options) };
});

let session: AgentSession | undefined;
afterEach(async () => {
  await session?.close();
  session = undefined;
});

async function start(decision: PermissionDecision = 'allow', resume?: string) {
  const requests: PermissionRequest[] = [];
  const events: AgentEvent[] = [];
  session = await startCodexSession({
    cwd: process.cwd(),
    clientName: 'test',
    executablePath: FAKE,
    resume,
    onPermission: async (request) => {
      requests.push(request);
      return decision;
    },
  });
  session.on((event) => events.push(event));
  return { session, requests, events };
}

describe('codex adapter', () => {
  it('streams a reply and resolves the turn', async () => {
    const { session, events } = await start();
    expect(session.id).toBe('thread-1');
    const result = await session.send('hello');
    expect(result).toMatchObject({ status: 'completed', text: 'Hello there' });
    expect(result.usage?.durationMs).toBeGreaterThanOrEqual(0);
    const deltas = events.filter((event) => event.type === 'text-delta').map((event) => event.text);
    expect(deltas.join('')).toBe('Hello there');
    expect(events[0]).toEqual({ type: 'turn-start', prompt: 'hello' });
    expect(events.at(-1)).toEqual({ type: 'turn-end', result });
  });

  it.each([
    ['allow', 'accept'],
    ['allow-session', 'acceptForSession'],
    ['deny', 'decline'],
  ] as const)('maps %s to the command decision %s', async (decision, expected) => {
    const { session, requests, events } = await start(decision);
    const result = await session.send('command');
    expect(JSON.parse(result.text)).toEqual({ decision: expected });
    expect(requests[0]).toMatchObject({ tool: 'command', title: 'Run touch x' });
    expect(events).toContainEqual({ type: 'tool-start', id: 'cmd-1', tool: 'commandExecution', title: 'touch x', detail: 'touch x' });
    expect(events).toContainEqual({ type: 'tool-end', id: 'cmd-1', ok: true, output: 'done' });
  });

  it('shows file paths and diffs in a file change request', async () => {
    const { session, requests } = await start('allow');
    const result = await session.send('file');
    expect(JSON.parse(result.text)).toEqual({ decision: 'accept' });
    expect(requests[0]).toMatchObject({ tool: 'fileChange', title: 'Edit a.md', detail: '-old\n+new' });
  });

  it('calls beforeFileChange when a file change starts and again before it asks', async () => {
    const calls: string[] = [];
    session = await startCodexSession({
      cwd: process.cwd(),
      clientName: 'test',
      executablePath: FAKE,
      beforeFileChange: async (paths) => {
        calls.push(`before ${paths.join(', ')}`);
      },
      onPermission: async (request) => {
        calls.push(`ask ${request.title}`);
        return 'allow';
      },
    });
    await session.send('file');
    expect(calls).toEqual(['before a.md', 'before a.md', 'ask Edit a.md']);
  });

  it('grants requested permissions only when allowed', async () => {
    const allowed = await start('allow-session');
    expect(JSON.parse((await allowed.session.send('permissions')).text)).toEqual({
      permissions: { network: { enabled: true } },
      scope: 'session',
    });
    await allowed.session.close();
    const denied = await start('deny');
    expect(JSON.parse((await denied.session.send('permissions')).text)).toEqual({ permissions: {}, scope: 'turn' });
  });

  it('passes instructions to the thread as developer instructions', async () => {
    session = await startCodexSession({ cwd: process.cwd(), clientName: 'test', executablePath: FAKE, instructions: 'Be brief.' });
    expect((await session.send('instructions')).text).toBe('Be brief.');
  });

  it('denies requests when there is no permission handler', async () => {
    session = await startCodexSession({ cwd: process.cwd(), clientName: 'test', executablePath: FAKE });
    expect(JSON.parse((await session.send('command')).text)).toEqual({ decision: 'decline' });
  });

  it('answers unsupported server requests with an error', async () => {
    const { session } = await start();
    const error = JSON.parse((await session.send('unsupported')).text);
    expect(error.code).toBe(-32601);
  });

  it('reports a failed turn with the last error', async () => {
    const { session } = await start();
    expect(await session.send('fail')).toMatchObject({ status: 'failed', text: '', error: 'model overloaded' });
  });

  it('interrupts a running turn and accepts the next message', async () => {
    const { session } = await start();
    const turn = session.send('wait');
    await new Promise((resolve) => setTimeout(resolve, 50));
    await session.interrupt();
    expect((await turn).status).toBe('interrupted');
    expect((await session.send('hello')).status).toBe('completed');
  });

  it('interrupts a turn before turn/start returns', async () => {
    const { session } = await start();
    const turn = session.send('wait');
    await session.interrupt();
    expect((await turn).status).toBe('interrupted');
  });

  it('runs messages sent during a turn after it, in order', async () => {
    const { session } = await start();
    const results = await Promise.all([session.send('one'), session.send('two'), session.send('three')]);
    expect(results.map((result) => result.text)).toEqual(['echo: one', 'echo: two', 'echo: three']);
  });

  it('fails the turn and closes the session when the process crashes', async () => {
    const { session, events } = await start();
    const result = await session.send('crash');
    expect(result.status).toBe('failed');
    expect(result.error).toContain('exited with code 3');
    expect(result.error).toContain('fatal: something broke');
    expect(session.closed).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'turn-end' });
    expect(events).toContainEqual(expect.objectContaining({ type: 'closed' }));
    await expect(session.send('hello')).rejects.toThrow('Session closed');
  });

  it('resumes a thread by id', async () => {
    const { session } = await start('allow', 'thread-1');
    expect(session.id).toBe('thread-1');
  });

  it('rejects when the thread to resume does not exist', async () => {
    await expect(start('allow', 'missing')).rejects.toThrow('no rollout found');
  });

  it('rejects when the executable does not exist', async () => {
    await expect(
      startCodexSession({ cwd: process.cwd(), clientName: 'test', executablePath: '/nonexistent/codex' }),
    ).rejects.toThrow('ENOENT');
  });

  it('shows the inner command of a shell wrapper', () => {
    expect(unwrapShell(`/bin/zsh -lc 'ls -a'`)).toBe('ls -a');
    expect(unwrapShell(`/bin/bash -c "pwd && git status"`)).toBe('pwd && git status');
    expect(unwrapShell('ls -a')).toBe('ls -a');
  });

  it('runs app tools that the agent calls', async () => {
    const calls: unknown[] = [];
    const tools = {
      name: 'note',
      description: 'Edit the note.',
      tools: [
        defineTool({
          name: 'append',
          description: 'Appends text.',
          input: { text: z.string() },
          title: (input) => `Append ${input.text}`,
          run: async (input) => {
            calls.push(input);
            return `appended ${input.text}`;
          },
        }),
      ],
    };
    const events: AgentEvent[] = [];
    session = await startCodexSession({ cwd: process.cwd(), clientName: 'test', executablePath: FAKE, tools });
    session.on((event) => events.push(event));
    const result = await session.send('tool');
    expect(calls).toEqual([{ text: 'hi' }]);
    expect(JSON.parse(result.text)).toEqual({ contentItems: [{ type: 'inputText', text: 'appended hi' }], success: true });
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool-start', tool: 'note.append', title: 'Append hi' }));
    const setup = JSON.parse((await session.send('setup')).text);
    expect(setup.capabilities).toEqual({ experimentalApi: true, requestAttestation: false });
    expect(setup.dynamicTools[0]).toMatchObject({ type: 'namespace', name: 'note', tools: [{ name: 'append' }] });
    expect(setup.dynamicTools[0].tools[0].inputSchema.properties.text).toEqual({ type: 'string' });
  });

  it('reports an error result when an app tool throws', async () => {
    const tools = {
      name: 'note',
      description: 'Edit the note.',
      tools: [defineTool({ name: 'append', description: '', input: { text: z.string() }, run: async () => { throw new Error('no note'); } })],
    };
    session = await startCodexSession({ cwd: process.cwd(), clientName: 'test', executablePath: FAKE, tools });
    expect(JSON.parse((await session.send('tool')).text)).toEqual({ contentItems: [{ type: 'inputText', text: 'no note' }], success: false });
  });

  it('runs read-only without approvals', async () => {
    session = await startCodexSession({ cwd: process.cwd(), clientName: 'test', executablePath: FAKE, access: 'read-only' });
    const setup = JSON.parse((await session.send('setup')).text);
    expect(setup).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'never', capabilities: null });
  });

  it('passes an enforced mention policy and denies native approval bypasses', async () => {
    const handler = vi.fn(async () => 'allow' as const);
    session = await startCodexSession({ cwd: process.cwd(), clientName: 'test', executablePath: FAKE, access: 'read-only',
      inlineTools: { webSearch: true, shell: true, mcpTools: { logs: ['read'] } }, onPermission: handler });
    const setup = JSON.parse((await session.send('setup')).text);
    expect(setup.config).toMatchObject({ web_search: 'live', 'features.shell_tool': false,
      mcp_servers: { logs: { enabled_tools: ['read'] }, mail: { enabled: false } } });
    expect(JSON.parse((await session.send('command')).text)).toEqual({ decision: 'decline' });
    expect(JSON.parse((await session.send('file')).text)).toEqual({ decision: 'decline' });
    expect(JSON.parse((await session.send('permissions')).text)).toEqual({ permissions: {}, scope: 'turn' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('streams reasoning summaries as thinking', async () => {
    const { session, events } = await start();
    await session.send('reasoning');
    const deltas = events.filter((event) => event.type === 'thinking-delta').map((event) => event.text);
    expect(deltas.join('')).toBe('Plan the reply\n\nCheck the note');
    expect(events).toContainEqual({ type: 'thinking', text: 'Plan the reply\n\nCheck the note' });
  });

  it('lists models with their effort levels', async () => {
    const { session } = await start();
    expect(await session.models()).toEqual([
      { id: 'gpt-fast', name: 'Fast', description: 'Quick', efforts: ['low', 'high'], defaultEffort: 'low', isDefault: true },
    ]);
  });

  it('sends the configured model and effort with the next turn', async () => {
    const { session } = await start();
    await session.configure({ model: 'gpt-fast', effort: 'high' });
    expect(JSON.parse((await session.send('turn-settings')).text)).toEqual({ model: 'gpt-fast', effort: 'high' });
  });

  it('lists skills as commands and invokes one with a slash', async () => {
    const { session } = await start();
    expect(await session.commands()).toEqual([{ name: 'summarize', description: 'Summarize a note' }]);
    const input = JSON.parse((await session.send('/summarize Ideas.md')).text);
    expect(input).toEqual([
      { type: 'skill', name: 'summarize', path: '/skills/summarize/SKILL.md' },
      { type: 'text', text: 'Ideas.md', text_elements: [] },
    ]);
  });

  it('closes cleanly while idle', async () => {
    const { session, events } = await start();
    await session.close();
    expect(session.closed).toBe(true);
    expect(events).toEqual([{ type: 'closed', error: undefined }]);
  });
});
