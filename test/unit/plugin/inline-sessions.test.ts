import { describe, expect, it, vi } from 'vitest';
import type { NoteSessionsOptions, ObsidianYami, SessionIds } from 'yami/obsidian';
import { InlineSessions } from '../../../plugin/src/inline-sessions.ts';
import { inlineSessionKey } from '../../../plugin/src/inline-tools.ts';
import type { AgentProfile } from '../../../plugin/src/settings.ts';

const profile = (): AgentProfile => ({ name: 'ai', harness: 'codex', executablePath: '', env: '', model: '', effort: '', approval: 'ask', userTools: false,
  inlineToolsEnabled: true, inlineWebSearch: true, inlineShell: false, inlineShellApproval: 'ask', inlineMcpTools: '', color: '#123456' });

function host() {
  const groups: { options: NoteSessionsOptions; ids: SessionIds; session: ReturnType<typeof vi.fn>; forget: ReturnType<typeof vi.fn> }[] = [];
  const yami = { noteSessions: (options: NoteSessionsOptions) => {
    const group = { options, ids: structuredClone(options.ids ?? {}), session: vi.fn(async () => ({})), forget: vi.fn(async (path: string) => {
      delete group.ids[path];
      await options.save?.(structuredClone(group.ids));
    }) };
    groups.push(group);
    return group;
  } } as unknown as ObsidianYami;
  return { yami, groups };
}

describe('policy-specific Yami note sessions', () => {
  it('reuses one group for a policy and a separate group for changed permissions', async () => {
    const { yami, groups } = host();
    const sessions = new InlineSessions(yami, {}, async () => {}, () => ({}));
    const agent = profile();
    await sessions.session('note.md', agent);
    await sessions.session('note.md', agent);
    expect(groups).toHaveLength(1);
    agent.inlineShell = true;
    await sessions.session('note.md', agent);
    expect(groups).toHaveLength(2);
    agent.inlineShell = false;
    await sessions.session('note.md', agent);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.session).toHaveBeenCalledTimes(3);
  });

  it('restores each policy and merges saved IDs without overwriting other agents', async () => {
    const { yami, groups } = host();
    const key = inlineSessionKey(profile());
    const save = vi.fn(async (_ids: SessionIds) => {});
    new InlineSessions(yami, { 'note.md': { [key]: 'saved', claude: 'claude-id' } }, save, () => ({}));
    const policyGroup = groups.find(group => group.ids['note.md']?.ai)!;
    expect(policyGroup.ids).toEqual({ 'note.md': { ai: 'saved' } });
    await policyGroup.options.save?.({ 'note.md': { ai: 'next' } });
    expect(save).toHaveBeenLastCalledWith({ 'note.md': { [key]: 'next', claude: 'claude-id' } });
  });

  it('follows saved group rename events and forgets every policy of the note', async () => {
    const { yami, groups } = host();
    const agent = profile(), key = inlineSessionKey(agent), save = vi.fn(async (_ids: SessionIds) => {});
    const sessions = new InlineSessions(yami, { 'note.md': { [key]: 'saved' } }, save, () => ({}));
    groups[0]!.ids = { 'renamed.md': { ai: 'saved' } };
    await groups[0]!.options.save?.(groups[0]!.ids);
    expect(save).toHaveBeenLastCalledWith({ 'renamed.md': { [key]: 'saved' } });
    await sessions.forget('renamed.md');
    expect(save).toHaveBeenLastCalledWith({});
  });
});
