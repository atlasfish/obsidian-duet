import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inlineSessionKey, parseInlineMcpTools } from '../../../plugin/src/inline-tools.ts';
import type { AgentProfile } from '../../../plugin/src/settings.ts';
import { inlineCommandTool, runTool } from '../../../src/index.ts';

let cwd: string;
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), 'duet-command-')); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

describe('inline tools', () => {
  it('parses exact MCP names, deduplicates them, and rejects wildcards', () => {
    expect(parseInlineMcpTools(' logs/read\nlogs/read\nlogs/tail\n\nmail/list ')).toEqual({ logs: ['read', 'tail'], mail: ['list'] });
    expect(() => parseInlineMcpTools('logs/*')).toThrow('exact server/tool');
    expect(() => parseInlineMcpTools('logs')).toThrow('exact server/tool');
  });

  it('starts a distinct conversation when any tool permission changes', () => {
    const profile = { name: 'ai', harness: 'codex', inlineToolsEnabled: false, inlineWebSearch: false, inlineShell: false, inlineMcpTools: '' } as AgentProfile;
    expect(inlineSessionKey(profile)).toBe('ai');
    profile.inlineToolsEnabled = true;
    const first = inlineSessionKey(profile);
    profile.inlineShell = true;
    expect(inlineSessionKey(profile)).not.toBe(first);
    profile.inlineShell = false;
    expect(inlineSessionKey(profile)).toBe(first);
  });

  it('does not execute a denied command', async () => {
    const permission = vi.fn(async () => 'deny' as const);
    const tool = inlineCommandTool(cwd, permission);
    const result = await runTool(tool, { command: 'echo forbidden > denied.txt' }, new AbortController().signal);
    expect(result.isError).toBe(true);
    await expect(access(join(cwd, 'denied.txt'))).rejects.toThrow();
    expect(permission.mock.calls).toHaveLength(1);
  });

  it('shows each command and working directory before executing, without caching approval', async () => {
    const permission = vi.fn(async () => 'allow-session' as const);
    const tool = inlineCommandTool(cwd, permission);
    for (let i = 0; i < 2; i++) {
      const result = await runTool(tool, { command: 'echo approved > approved.txt' }, new AbortController().signal);
      expect(result.isError).toBe(false);
    }
    expect((await readFile(join(cwd, 'approved.txt'), 'utf8')).trim()).toBe('approved');
    expect(permission.mock.calls).toHaveLength(2);
    expect((permission.mock.calls as unknown as [{ detail: string }][])[0]![0].detail).toContain(cwd);
  });

  it('cannot execute after cancellation or invalid arguments', async () => {
    const permission = vi.fn(async () => 'allow' as const);
    const tool = inlineCommandTool(cwd, permission);
    const controller = new AbortController(); controller.abort();
    expect((await runTool(tool, { command: 'echo test > cancelled.txt' }, controller.signal)).isError).toBe(true);
    expect((await runTool(tool, { command: '', timeout_seconds: 999 }, new AbortController().signal)).isError).toBe(true);
    expect(permission).not.toHaveBeenCalled();
  });

  it('runs YOLO commands without requesting approval', async () => {
    const permission = vi.fn(async () => 'deny' as const);
    const tool = inlineCommandTool(cwd, permission, 'yolo');
    expect((await runTool(tool, { command: 'echo yolo > yolo.txt' }, new AbortController().signal)).isError).toBe(false);
    expect((await readFile(join(cwd, 'yolo.txt'), 'utf8')).trim()).toBe('yolo');
    expect(permission).not.toHaveBeenCalled();
  });

  it('passes the configured environment to commands', async () => {
    const tool = inlineCommandTool(cwd, async () => 'deny', 'yolo', { DUET_COMMAND_TEST: 'profile-env' });
    const result = await runTool(tool, { command: `"${process.execPath}" -e "console.log(process.env.DUET_COMMAND_TEST)"` }, new AbortController().signal);
    expect(result.isError).toBe(false);
    expect(result.text).toContain('profile-env');
  });

  it('stops a running command when the turn is cancelled', async () => {
    const controller = new AbortController();
    const tool = inlineCommandTool(cwd, async () => 'deny', 'yolo');
    const running = runTool(tool, { command: `"${process.execPath}" -e "console.log('started');setTimeout(()=>{},30000)"` }, controller.signal);
    const timer = setTimeout(() => controller.abort(), 300);
    try {
      const result = await running;
      expect(result.isError).toBe(true);
      expect(result.text).toContain('cancelled');
    } finally { clearTimeout(timer); }
  }, 10000);

  it('kills a timed-out command instead of leaving it running', async () => {
    const tool = inlineCommandTool(cwd, async () => 'allow');
    const result = await runTool(tool, { command: `"${process.execPath}" -e "setTimeout(()=>require('fs').writeFileSync('late.txt','bad'),4000)"`, timeout_seconds: 1 }, new AbortController().signal);
    expect(result).toMatchObject({ isError: true });
    expect(result.text).toContain('timed out');
    await expect(access(join(cwd, 'late.txt'))).rejects.toThrow();
  }, 10000);
});
