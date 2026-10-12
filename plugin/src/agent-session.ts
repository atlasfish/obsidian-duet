import { type App, FileSystemAdapter } from 'obsidian';
import {
  type AgentEvent,
  type AgentSession,
  approvalOptions,
  type ApprovalSetting,
  createSession,
  type CreateSessionOptions,
  type PermissionHandler,
  type QuestionHandler,
  type ToolSet,
  type InlineToolPolicy,
} from '../../src/index.ts';
import { AgentPeer } from './collab/agent-peer.ts';
import type { SharedNote } from './collab/shared-note.ts';
import { type AgentProfile, displayName, parseEnv } from './settings.ts';

export interface StartOptions {
  profile: AgentProfile;
  instructions: string;
  access: 'workspace' | 'read-only';
  resume?: string;
  tools?: ToolSet;
  inlineTools?: InlineToolPolicy;
  model?: string;
  effort?: string;
  approval?: ApprovalSetting;
  onPermission?: PermissionHandler;
  onQuestion?: QuestionHandler;
  beforeFileChange?: (paths: string[]) => Promise<void> | void;
}

export function vaultRoot(app: App): string {
  const adapter = app.vault.adapter;
  if (!(adapter instanceof FileSystemAdapter)) throw new Error('Duet needs a vault on the local file system.');
  return adapter.getBasePath();
}

/** Starts a harness session for a profile. When the stored conversation is gone, starts a new one. */
export async function startAgent(app: App, options: StartOptions): Promise<AgentSession> {
  const { profile } = options;
  const build = (resume?: string): CreateSessionOptions => ({
    harness: profile.harness,
    cwd: vaultRoot(app),
    clientName: 'obsidian-duet',
    executablePath: profile.executablePath || undefined,
    env: {
      ...(profile.harness === 'claude' && { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' }),
      ...parseEnv(profile.env),
    },
    model: options.model || profile.model || undefined,
    effort: options.effort || profile.effort || undefined,
    instructions: options.instructions,
    resume,
    tools: options.tools,
    access: options.access,
    onPermission: options.onPermission,
    onQuestion: options.onQuestion,
    beforeFileChange: options.beforeFileChange,
    ...approvalOptions(profile.harness, options.approval ?? profile.approval),
    ...(profile.harness === 'claude' && { sdkOptions: { strictMcpConfig: !profile.userTools } }),
    ...(profile.harness === 'codex' && options.inlineTools && { inlineTools: options.inlineTools }),
  });
  if (!options.resume) return createSession(build());
  try {
    return await createSession(build(options.resume));
  } catch {
    // The stored conversation is gone, for example after the harness cleaned up old sessions.
    return createSession(build());
  }
}

/** The agent's cursors, one for each shared note that it works in. */
export class Presence {
  private readonly peers = new Map<SharedNote, AgentPeer>();
  private status: string | undefined;

  constructor(
    private readonly profile: AgentProfile,
    private readonly animate: () => boolean,
  ) {}

  peer(note: SharedNote): AgentPeer {
    let peer = this.peers.get(note);
    if (!peer) {
      peer = new AgentPeer(note, { name: displayName(this.profile), color: this.profile.color }, this.animate);
      peer.setStatus(this.status);
      this.peers.set(note, peer);
    }
    return peer;
  }

  /** Shows what the agent does now, next to each of its cursors. */
  setStatus(status: string | undefined): void {
    this.status = status;
    for (const peer of this.peers.values()) peer.setStatus(status);
  }

  /** Starts a new undo step in every note. */
  beginTurn(): void {
    for (const peer of this.peers.values()) peer.beginTurn();
  }

  /** Removes the cursors. */
  clear(): void {
    for (const peer of this.peers.values()) peer.dispose();
    this.peers.clear();
  }
}

/** A short status for the agent's cursor, from an event. Undefined keeps the current status. */
export function activity(event: AgentEvent): string | undefined {
  switch (event.type) {
    case 'turn-start':
    case 'thinking-delta':
    case 'tool-end':
      return 'Thinking';
    case 'text-delta':
      return 'Writing';
    case 'tool-start':
      return toolActivity(event.tool, event.title, event.paths);
    default:
      return undefined;
  }
}

function toolActivity(tool: string, title: string, paths: string[] | undefined): string {
  const file = paths?.[0]?.split('/').pop();
  if (tool.endsWith('read_note')) return 'Reading the note';
  if (tool.endsWith('edit_note')) return 'Editing the note';
  if (tool.endsWith('write_note')) return 'Rewriting the note';
  switch (tool) {
    case 'Read':
      return file ? `Reading ${file}` : 'Reading';
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
    case 'fileChange':
      return file ? `Editing ${file}` : 'Editing';
    case 'Grep':
    case 'Glob':
      return 'Searching';
    case 'WebSearch':
    case 'webSearch':
      return 'Searching the web';
    case 'WebFetch':
      return 'Reading a web page';
    case 'Bash':
    case 'commandExecution':
      return `Running ${title.replace(/^Bash /, '').slice(0, 40)}`;
    default:
      return title.slice(0, 48);
  }
}
