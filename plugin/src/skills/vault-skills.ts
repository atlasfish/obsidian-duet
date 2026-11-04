import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { type App, normalizePath, type Plugin } from 'obsidian';
import { vaultRoot } from 'yami/obsidian';
import { type AgentProfile, parseEnv } from '../settings.ts';
import { agentForm, description, type Recognized, recognize, type VaultForm } from './forms.ts';

/** The skill set that Duet builds from the vault's skills. Its folder's name is the set's name, so a skill is `/vault:<name>`. */
export const SET_FOLDER = '.duet/skills/vault';
export const SET_NAME = 'vault';
/** Time between a file event and the sync, so a folder that is copied in triggers one sync. */
const SYNC_DELAY_MS = 600;
/** How long a listing of the user's installed skills is kept. */
const INSTALLED_TTL_MS = 5000;

/** A skill or an agent with its description, for the suggestions and the settings. */
export interface SkillItem {
  name: string;
  kind: 'skill' | 'agent';
  description: string;
  /** `vault` for a file of the vault, `installed` for one of the harness's own folders. */
  source: 'vault' | 'installed';
  path: string;
}

/** What `@agent/<name>` invokes: a skill by its slash command, or a subagent by its name. */
export type Invocation = { kind: 'skill'; command: string } | { kind: 'agent'; name: string };

export interface VaultSkillsOptions {
  enabled(): boolean;
  /** Folders whose files never count, such as the conversation folder. `internal/` is always out: Yami's modules live there. */
  exclude(): string[];
  /** The skills or the agents changed, so the agents need new options. */
  onChange(): void;
}

/**
 * The skills and agents that the vault holds: every `SKILL.md` and `AGENT.md` in a named folder. Duet
 * copies the skill folders into one skill set under `.duet/skills/`, which Claude Code loads as a plugin
 * and Codex as a skill root, and turns each `AGENT.md` into a subagent of Claude Code.
 */
export class VaultSkills {
  private found: Recognized = { skills: [], agents: [], problems: [] };
  private definitions: Record<string, { description: string; prompt: string; tools?: string[]; model?: string }> = {};
  private skillDescriptions = new Map<string, string>();
  /** Names the state that the agents were built with: the skills' files and the agents' definitions. */
  private signature = '';
  private timer: number | undefined;
  private syncing: Promise<void> | undefined;
  private readonly installedCache = new Map<string, { time: number; items: SkillItem[] }>();

  constructor(
    private readonly app: App,
    private readonly options: VaultSkillsOptions,
  ) {}

  install(plugin: Plugin): void {
    const { vault, workspace } = this.app;
    const relevant = (file: string) => /(^|\/)(SKILL|AGENT)\.md$/.test(file) || this.found.skills.some((skill) => file.startsWith(`${skill.folder}/`) || file === skill.folder);
    const changed = (file: string) => {
      if (this.options.enabled() && relevant(file)) this.schedule();
    };
    plugin.registerEvent(vault.on('create', (file) => changed(file.path)));
    plugin.registerEvent(vault.on('modify', (file) => changed(file.path)));
    plugin.registerEvent(vault.on('delete', (file) => changed(file.path)));
    plugin.registerEvent(
      vault.on('rename', (file, oldPath) => {
        changed(file.path);
        changed(oldPath);
      }),
    );
    workspace.onLayoutReady(() => this.schedule(0));
  }

  /** The setting changed. */
  refresh(): void {
    this.schedule(0);
  }

  get skills(): readonly VaultForm[] {
    return this.found.skills;
  }

  get agents(): readonly VaultForm[] {
    return this.found.agents;
  }

  get problems(): readonly string[] {
    return this.found.problems;
  }

  /** Names the skills and agents as the agents were built with them. A changed key means the agents need new options. */
  get key(): string {
    return this.signature;
  }

  /** The skill set's folder, as an absolute path, when the vault has skills. */
  setRoot(): string | undefined {
    return this.options.enabled() && this.found.skills.length ? path.join(vaultRoot(this.app), SET_FOLDER) : undefined;
  }

  /** The skill set for a Codex mention session. Claude Code gets the set through `sdkOptions`. */
  sessionSkills(profile: AgentProfile): string[] {
    const root = this.setRoot();
    return profile.harness === 'codex' && root ? [root] : [];
  }

  /** The Agent SDK options of a Claude Code agent: the skill set as a plugin, and the vault's agents as subagents. */
  sdkOptions(profile: AgentProfile): Partial<Options> | undefined {
    if (profile.harness !== 'claude' || !this.options.enabled()) return undefined;
    const root = this.setRoot();
    const agents = Object.keys(this.definitions).length ? this.definitions : undefined;
    if (!root && !agents) return undefined;
    return { ...(root && { plugins: [{ type: 'local', path: root, skipMcpDiscovery: true }] }), ...(agents && { agents }) };
  }

  /** What `@<agent>/<name>` runs for this profile, or none when nothing has the name. */
  resolve(profile: AgentProfile, name: string): Invocation | undefined {
    const wanted = name.toLowerCase();
    for (const item of this.items(profile)) {
      if (item.name.toLowerCase() !== wanted) continue;
      if (item.kind === 'agent') return { kind: 'agent', name: item.name };
      return { kind: 'skill', command: item.source === 'vault' ? `${SET_NAME}:${item.name}` : item.name };
    }
    return undefined;
  }

  /** The skills and agents that `@<agent>/` can name for this profile: the vault's, then the user's installed ones. */
  items(profile: AgentProfile): SkillItem[] {
    const items: SkillItem[] = [];
    if (this.options.enabled()) {
      for (const skill of this.found.skills) items.push({ name: skill.name, kind: 'skill', description: this.skillDescriptions.get(skill.name) ?? '', source: 'vault', path: skill.path });
      if (profile.harness === 'claude') {
        for (const agent of this.found.agents) {
          const definition = this.definitions[agent.name];
          if (definition) items.push({ name: agent.name, kind: 'agent', description: definition.description, source: 'vault', path: agent.path });
        }
      }
    }
    const names = new Set(items.map((item) => `${item.kind}:${item.name}`));
    for (const item of this.installed(profile)) if (!names.has(`${item.kind}:${item.name}`)) items.push(item);
    return items;
  }

  /**
   * The skills and agents installed for the harness of a profile, read from its folders: Claude Code's
   * `skills/` and `agents/` under `CLAUDE_CONFIG_DIR` or `~/.claude` when the profile loads the user's
   * settings, and Codex's `skills/` under `CODEX_HOME` or `~/.codex`.
   */
  installed(profile: AgentProfile): SkillItem[] {
    const env = parseEnv(profile.env);
    const home = profile.harness === 'claude' ? (env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), '.claude')) : (env.CODEX_HOME ?? path.join(homedir(), '.codex'));
    if (profile.harness === 'claude' && !profile.userTools) return [];
    const cached = this.installedCache.get(home);
    if (cached && Date.now() - cached.time < INSTALLED_TTL_MS) return cached.items;
    const items: SkillItem[] = [];
    for (const folder of folders(path.join(home, 'skills'))) {
      const file = path.join(folder, 'SKILL.md');
      if (existsSync(file)) items.push({ name: path.basename(folder), kind: 'skill', description: safeDescription(file), source: 'installed', path: file });
    }
    if (profile.harness === 'claude') {
      for (const file of files(path.join(home, 'agents'), '.md')) {
        items.push({ name: path.basename(file, '.md'), kind: 'agent', description: safeDescription(file), source: 'installed', path: file });
      }
    }
    this.installedCache.set(home, { time: Date.now(), items });
    return items;
  }

  private schedule(delay = SYNC_DELAY_MS): void {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      this.syncing = (this.syncing ?? Promise.resolve()).then(() => this.sync()).catch((error: unknown) => console.error('Duet: could not sync the vault skills', error));
    }, delay);
  }

  /** Reads the vault, copies the skills into the set, reads the agents, and tells the host when something changed. */
  private async sync(): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!this.options.enabled()) {
      this.found = { skills: [], agents: [], problems: [] };
      this.definitions = {};
      this.skillDescriptions.clear();
      if (await adapter.exists(SET_FOLDER)) await adapter.rmdir(SET_FOLDER, true);
      this.finish('');
      return;
    }
    const found = recognize(
      this.app.vault.getFiles().map((file) => file.path),
      ['internal', SET_FOLDER, ...this.options.exclude()],
    );
    const signature: string[] = [];
    const skillsFolder = `${SET_FOLDER}/skills`;
    await mkdirp(adapter, skillsFolder);
    const kept = new Set<string>();
    this.skillDescriptions = new Map();
    for (const skill of found.skills) {
      kept.add(skill.name);
      const target = `${skillsFolder}/${skill.name}`;
      const copied = await this.mirror(skill.folder, target);
      signature.push(`skill ${skill.name} ${copied}`);
      const file = this.app.vault.getFileByPath(skill.path);
      if (file) this.skillDescriptions.set(skill.name, description(await this.app.vault.cachedRead(file)));
    }
    const existing = await adapter.exists(skillsFolder) ? await adapter.list(skillsFolder) : { files: [], folders: [] };
    for (const folder of existing.folders) if (!kept.has(folder.split('/').pop()!)) await adapter.rmdir(folder, true);
    for (const file of existing.files) await adapter.remove(file);
    if (!found.skills.length && (await adapter.exists(SET_FOLDER))) await adapter.rmdir(SET_FOLDER, true);

    const definitions: typeof this.definitions = {};
    for (const agent of found.agents) {
      const file = this.app.vault.getFileByPath(agent.path);
      if (!file) continue;
      const form = agentForm(await this.app.vault.cachedRead(file));
      if ('problem' in form) {
        found.problems.push(`${agent.path}: ${form.problem}`);
        continue;
      }
      definitions[agent.name] = form;
      signature.push(`agent ${agent.name} ${JSON.stringify(form)}`);
    }
    this.found = found;
    this.definitions = definitions;
    this.finish(signature.join('\n'));
  }

  private finish(signature: string): void {
    const changed = signature !== this.signature;
    this.signature = signature;
    if (changed) this.options.onChange();
  }

  /** Copies a folder of the vault into the set, file by file, and removes what the source no longer has. Returns a key of the copied content. */
  private async mirror(source: string, target: string): Promise<string> {
    const adapter = this.app.vault.adapter;
    const sources = await this.filesUnder(source);
    const copied = new Set<string>();
    const keys: string[] = [];
    await mkdirp(adapter, target);
    for (const file of sources) {
      const relative = file.slice(source.length + 1);
      const to = `${target}/${relative}`;
      copied.add(to);
      await mkdirp(adapter, to.slice(0, to.lastIndexOf('/')));
      const data = await adapter.readBinary(file);
      await adapter.writeBinary(to, data);
      keys.push(`${relative}:${hash(new Uint8Array(data))}`);
    }
    for (const file of await this.filesUnder(target)) if (!copied.has(file)) await adapter.remove(file);
    return hash(new TextEncoder().encode(keys.join('\n')));
  }

  /** Every file under a folder of the vault, through the adapter, so hidden folders count too. */
  private async filesUnder(folder: string): Promise<string[]> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(folder))) return [];
    const out: string[] = [];
    const walk = async (current: string) => {
      const listed = await adapter.list(current);
      out.push(...listed.files);
      for (const child of listed.folders) await walk(child);
    };
    await walk(folder);
    return out;
  }
}

async function mkdirp(adapter: App['vault']['adapter'], folder: string): Promise<void> {
  const parts = normalizePath(folder).split('/');
  for (let index = 1; index <= parts.length; index++) {
    const current = parts.slice(0, index).join('/');
    if (current && !(await adapter.exists(current))) await adapter.mkdir(current);
  }
}

/** A short hash of bytes, for a key that says whether a file changed. */
function hash(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (const byte of bytes) h = Math.imul(h ^ byte, 0x01000193) >>> 0;
  return `${bytes.length}-${h.toString(16)}`;
}

function folders(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

function files(dir: string, extension: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

function safeDescription(file: string): string {
  try {
    return description(readFileSync(file, 'utf8'));
  } catch {
    return '';
  }
}
