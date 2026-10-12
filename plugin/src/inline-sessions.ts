import type { NoteAgent, NoteSessions, NoteSessionSetup, ObsidianYami, SessionIds } from 'yami/obsidian';
import { inlineSessionKey } from './inline-tools.ts';
import type { AgentProfile } from './settings.ts';

/** One Yami note-session group per agent/tool policy, with the fork's persisted policy keys. */
export class InlineSessions<State> {
  private readonly groups = new Map<string, NoteSessions<State>>();
  private readonly ids: SessionIds;

  constructor(private readonly yami: ObsidianYami, ids: SessionIds,
    private readonly save: (ids: SessionIds) => Promise<void>,
    private readonly setup: (note: NoteAgent) => NoteSessionSetup<State>) {
    this.ids = structuredClone(ids);
    // Register saved groups so Yami also follows renames for sessions not opened this launch.
    for (const key of new Set(Object.values(ids).flatMap((agents) => Object.keys(agents)))) {
      this.group(key.split('#inline-')[0]!, key);
    }
  }

  session(path: string, profile: AgentProfile) {
    return this.group(profile.name, inlineSessionKey(profile)).session(path, profile.name);
  }

  async forget(path: string): Promise<void> {
    await Promise.all([...this.groups.values()].map((notes) => notes.forget(path)));
    delete this.ids[path];
    await this.save(structuredClone(this.ids));
  }

  private group(agent: string, key: string): NoteSessions<State> {
    let group = this.groups.get(key);
    if (!group) {
      const ids: SessionIds = {};
      for (const [path, agents] of Object.entries(this.ids)) {
        if (agents[key]) ids[path] = { [agent]: agents[key] };
      }
      group = this.yami.noteSessions({ ids, setup: this.setup, save: async (updated) => {
        for (const path of Object.keys(this.ids)) {
          delete this.ids[path]![key];
          if (!Object.keys(this.ids[path]!).length) delete this.ids[path];
        }
        for (const [path, agents] of Object.entries(updated)) {
          if (agents[agent]) (this.ids[path] ??= {})[key] = agents[agent];
        }
        await this.save(structuredClone(this.ids));
      } });
      this.groups.set(key, group);
    }
    return group;
  }
}
