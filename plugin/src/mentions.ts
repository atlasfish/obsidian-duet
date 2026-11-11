import { Notice, type TFile } from 'obsidian';
import type * as Y from 'yjs';
import type { AgentEvent, AgentSession } from 'yami/agent';
import { activity, type CollabHub, EditorBinding, LiveRegion, type NoteAgent, type NoteSessionSetup, type ObsidianYami, PermissionPrompts, Presence, type SessionIds, type SharedNote, vaultRoot } from 'yami/obsidian';
import { calloutHeader, isCalloutHeader, renderCallout, type ReplyState } from './callout.ts';
import { lineAt, type NoteComments, passage, type Thread } from './comments/model.ts';
import type { CommentStore } from './comments/store.ts';
import type { TriggeredMention } from './enter-trigger.ts';
import { NoteTools, PLACEHOLDER } from './note-tools.ts';
import { type AgentProfile, displayName, parseEnv } from './settings.ts';
import { inlineCommandTool } from './inline-command.ts';
import { inlinePolicy } from './inline-tools.ts';
import { InlineSessions } from './inline-sessions.ts';
import type { VaultSkills } from './skills/vault-skills.ts';

const INSTRUCTIONS = `You are running inside Obsidian, the note-taking app, through the Duet plugin. Your working directory is the root of the user's vault.

The user calls you by writing @ and your name with a request on a line of a note. Each message gives the note's path, its text, and the request. In the note text, the line ${PLACEHOLDER} stands for the request line and the callout that holds your reply.

What you can change:
- For note edits, you can change only the note that the request is in. Change it with the duet tools: read_note, edit_note for targeted changes, and write_note for a broad rewrite. The user sees each edit as you make it and may type at the same time.
- You cannot change any other file. You have no file-editing tools and no shell, and the duet tools work only on this note.
- You can read other files in the vault, and search them, when the request needs them.
- Do not try to change the request line or your reply callout. The plugin writes your reply.

Comments:
- The user can also comment on a highlighted passage of the note and tag you in the comment. Such a message gives the passage, its thread, and the comment. Address the comment, and keep your changes to that passage: the rest of the note is context. Your final message is then your reply in the thread.
- A message can ask you to handle every open comment of the note at once. Then answer each thread with the reply_to_comment tool, by the thread id in the message, and keep your final message to one line.

How to answer:
- Your final message goes into the reply callout under the request, or into the comment thread. Write Markdown that reads well there. Obsidian links like [[Note name]] work.
- Answer directly. Leave out preambles, sign-offs and offers of more help. Keep the reply short unless the user asks for more.
- Change the note only when the request asks for it. For a broad rewrite, such as "clean this up", keep the user's meaning, facts, links and structure unless asked otherwise. Then say in one sentence what you changed.
- Wait for each tool to finish. Do not start background work.`;

export interface Mention extends TriggeredMention {
  profile: AgentProfile;
}

interface Reply {
  title: string;
  note: SharedNote | undefined;
  region: LiveRegion | undefined;
  /** Text of the message that is streaming now. */
  streaming: string;
  /** The last complete message. */
  message: string;
  /** Start of the request line. With the callout, it is hidden from the agent's view of the note. */
  line: Y.RelativePosition | undefined;
  /** Wraps the callout in the text around it, for a reply that is not under a request. */
  wrap?: (callout: string) => string;
  /** A reply into the comments of the note instead of a callout: into one thread, or, with no id, a turn over every open thread. */
  thread?: { id: string | undefined; file: TFile; agent: string };
}

/** A comment that tags an agent: the thread, its comments as they are now, and the note's comments. */
export interface ThreadRequest {
  file: TFile;
  profile: AgentProfile;
  thread: Thread;
  comments: NoteComments;
}

/** Every thread that waits for an answer, for one turn. */
export interface ThreadsRequest {
  file: TFile;
  profile: AgentProfile;
  threads: Thread[];
  comments: NoteComments;
}

/** The mention agent of one harness session in one note: its cursors, its note tools, and its replies. */
class LiveSession {
  readonly replies: Reply[] = [];
  current: Reply | undefined;
  session!: AgentSession;
  readonly presence: Presence;
  readonly tools: NoteTools;

  constructor(
    public profile: AgentProfile,
    readonly file: TFile,
    hub: CollabHub,
    animate: () => boolean,
    comments: CommentStore,
  ) {
    this.presence = new Presence(() => ({ name: this.profile.name, color: this.profile.color }), animate);
    this.tools = new NoteTools({
      note: () => hub.acquire(file, this.tools),
      peer: (note) => this.presence.peer(note),
      hidden: (note) => hiddenRange(note, this.current),
      replyToComment: async (threadId, text) => {
        if (!(await comments.addComment(file.path, threadId, { author: 'agent', agent: this.profile.name, text }))) {
          throw new Error(`The note has no comment thread with the id ${threadId}.`);
        }
      },
    });
  }

  get busy(): boolean {
    return this.current !== undefined || this.replies.length > 0;
  }
}

export interface MentionOptions {
  ids: SessionIds;
  save(ids: SessionIds): Promise<void>;
  profile(name: string): AgentProfile | undefined;
  comments: CommentStore;
  skills: VaultSkills;
}

/**
 * Answers mentions. Each note and agent pair has one harness session, from Yami's note sessions. The agent
 * reads the note, may change it through the note tools, and writes its reply into a callout under the
 * request, with a live cursor.
 */
export class MentionAgents {
  private readonly hub: CollabHub;
  private readonly notes: InlineSessions<LiveSession>;
  private readonly prompts: PermissionPrompts;

  constructor(
    private readonly yami: ObsidianYami,
    private readonly options: MentionOptions,
  ) {
    this.hub = yami.hub;
    this.prompts = new PermissionPrompts(yami.plugin.app);
    this.notes = new InlineSessions(yami, options.ids, (ids) => options.save(ids), (note) => this.setup(note));
  }

  private setup({ file, agent }: NoteAgent): NoteSessionSetup<LiveSession> {
    const profile = this.options.profile(agent);
    if (!profile) throw new Error(`Duet has no agent named ${agent}.`);
    const live = new LiveSession(profile, file, this.hub, this.yami.animate, this.options.comments);
    const policy = inlinePolicy(profile);
    const onPermission = (request: Parameters<PermissionPrompts['ask']>[0]) => this.prompts.ask(request, { agent: displayName(profile), notePath: file.path });
    const tools = live.tools.tools;
    if (policy?.shell) tools.tools.push(inlineCommandTool(vaultRoot(this.yami.plugin.app), onPermission, policy.shellApproval, parseEnv(profile.env)));
    let instructions = INSTRUCTIONS;
    if (policy?.shell) instructions = instructions.replace(
      '- You cannot change any other file. You have no file-editing tools and no shell, and the duet tools work only on this note.',
      `- Direct note edits use the duet note tools. External queries and scripts use duet.run_command, which runs with Obsidian's host OS permissions outside Codex's native sandbox. Determine command access from its execution results. ${policy.shellApproval === 'yolo' ? 'The user enabled YOLO: commands run without approval prompts.' : 'The user approves each command.'} Do not edit this note with a command; that bypasses live editing and undo.`,
    );
    if (policy) instructions += `\n\nOptional tools: native web search is ${policy.webSearch ? 'enabled when supported by the provider' : 'disabled'}. Only the configured MCP tools are available. Shell is ${policy.shell ? 'available through duet.run_command' : 'disabled'}.`;
    return {
      // Claude Code gets the vault's skill set as a plugin of its agent; Codex takes it here, as a skill root of the session.
      options: { instructions, access: 'read-only', tools, skills: this.options.skills.sessionSkills(profile), ...(policy && { onPermission }) },
      state: live,
      started: (session) => {
        live.session = session;
        session.on((event) => {
          this.handle(live, event);
          if (event.type === 'closed') this.release(live);
        });
      },
    };
  }

  async ask(mention: Mention): Promise<void> {
    const { file, profile, view } = mention;
    const binding = EditorBinding.of(view);
    const tracked = binding?.track(mention.lineFrom, mention.callout.to);
    const reply: Reply = { title: displayName(profile), note: undefined, region: undefined, streaming: '', message: '', line: undefined };
    let live: LiveSession;
    try {
      const [note, started] = await Promise.all([this.hub.acquire(file, reply), this.notes.session(file.path, profile)]);
      live = started.state;
      live.profile = profile;
      reply.note = note;
      if (tracked) binding!.untrack(tracked);
      const lineFrom = tracked?.from ?? mention.lineFrom;
      const calloutFrom = note.content.indexOf(calloutHeader(reply.title), lineFrom);
      if (calloutFrom < 0) throw new Error('The reply callout is gone.');
      const peer = live.presence.peer(note);
      peer.beginTurn();
      reply.region = new LiveRegion(peer, calloutFrom, calloutFrom + calloutHeader(reply.title).length, isCalloutHeader);
      reply.line = note.relative(lineFrom, -1);
      peer.setCursor(note.relative(calloutFrom + calloutHeader(reply.title).length, -1));
    } catch (error) {
      if (tracked) binding!.untrack(tracked);
      new Notice(`@${profile.name} could not start: ${(error as Error).message}`);
      if (reply.note) this.hub.release(reply.note, reply);
      return;
    }
    const invocation = mention.skill === undefined ? undefined : this.options.skills.resolve(profile, mention.skill);
    if (mention.skill !== undefined && !invocation) {
      void this.finish(live, reply, { kind: 'failed', text: '', error: `@${profile.name} has no skill or agent named ${mention.skill}.` });
      return;
    }
    live.replies.push(reply);
    const text = await live.tools.show((note) => hiddenRange(note, reply));
    const prompt = [
      // A skill is a slash command, which must start the message. Claude Code and Yami's Codex adapter put its instructions in the turn.
      ...(invocation?.kind === 'skill' ? [`/${invocation.command}`] : []),
      `Note: ${file.path} (line ${mention.line + 1})`,
      text === undefined ? 'The note has not changed since you last read it.' : `<note>\n${text}\n</note>`,
      ...(invocation?.kind === 'agent' ? [`Give this request to your subagent "${invocation.name}" with the Agent tool, and relay its result as your reply.`] : []),
      `Request: ${mention.prompt}`,
    ].join('\n\n');
    await live.session.send(prompt).catch((error: Error) => {
      // The session closed before this turn started. The 'closed' handler may already have failed the reply.
      const index = live.replies.indexOf(reply);
      if (index < 0) return;
      live.replies.splice(index, 1);
      void this.finish(live, reply, { kind: 'failed', text: '', error: error.message });
    });
  }

  /** Runs the agent on one comment thread. The reply streams into the thread. */
  async askInThread({ file, profile, thread, comments }: ThreadRequest): Promise<void> {
    await this.sendToThreads(file, profile, thread.id, (text) =>
      [
        `Note: ${file.path}`,
        text,
        `The user commented on this passage of the note${thread.to > thread.from ? ` (line ${lineAt(comments.text, thread.from)})` : ''} and tagged you in the latest comment. Address it. Change only this passage when a change is needed; the rest of the note is context. Your final message is your reply in the thread.`,
        describeThread(thread, comments, false),
      ].join('\n\n'),
    );
  }

  /** Runs the agent on every thread that waits for an answer, in one turn. It replies with the reply_to_comment tool. */
  async handleThreads({ file, profile, threads, comments }: ThreadsRequest): Promise<void> {
    await this.sendToThreads(file, profile, undefined, (text) =>
      [
        `Note: ${file.path}`,
        text,
        `The user left ${threads.length === 1 ? 'one comment' : `${threads.length} comments`} on passages of this note. Address each one. Change only the passage of a comment when it needs a change; the rest of the note is context. Reply in each thread with the reply_to_comment tool, with the thread's id. Your final message is not shown to the user, so keep it to one line.`,
        ...threads.map((thread) => describeThread(thread, comments, true)),
      ].join('\n\n'),
    );
  }

  private async sendToThreads(file: TFile, profile: AgentProfile, threadId: string | undefined, prompt: (noteText: string) => string): Promise<void> {
    const { comments } = this.options;
    const reply: Reply = { title: displayName(profile), note: undefined, region: undefined, streaming: '', message: '', line: undefined, thread: { id: threadId, file, agent: profile.name } };
    let live: LiveSession;
    try {
      const [note, started] = await Promise.all([this.hub.acquire(file, reply), this.notes.session(file.path, profile)]);
      live = started.state;
      live.profile = profile;
      reply.note = note;
      live.presence.peer(note).beginTurn();
    } catch (error) {
      new Notice(`@${profile.name} could not start: ${(error as Error).message}`);
      if (reply.note) this.hub.release(reply.note, reply);
      return;
    }
    if (threadId) comments.setPending(file.path, threadId, { agent: profile.name, text: '', state: 'working' });
    live.replies.push(reply);
    const text = await live.tools.show(() => undefined);
    await live.session.send(prompt(text === undefined ? 'The note has not changed since you last read it.' : `<note>\n${text}\n</note>`)).catch((error: Error) => {
      const index = live.replies.indexOf(reply);
      if (index < 0) return;
      live.replies.splice(index, 1);
      void this.finish(live, reply, { kind: 'failed', text: '', error: error.message });
    });
  }

  /** Ends the conversations in a note. The next mention starts new ones. */
  forget(file: TFile): Promise<void> {
    return this.notes.forget(file.path);
  }

  /** Removes the agent's cursors and lets go of the note that its tools shared. */
  private release(live: LiveSession): void {
    live.presence.clear();
    const note = this.hub.get(live.file.path);
    if (note) this.hub.release(note, live.tools);
  }

  private handle(live: LiveSession, event: AgentEvent): void {
    const status = activity(event);
    if (status) live.presence.setStatus(status);
    const reply = live.current;
    switch (event.type) {
      case 'turn-start':
        live.current = live.replies.shift();
        if (!live.current) void this.followUp(live);
        break;
      case 'text-delta':
        if (!reply) break;
        reply.streaming += event.text;
        this.render(reply, { kind: 'working', text: reply.streaming });
        break;
      case 'message':
        if (!reply) break;
        reply.message = event.text;
        reply.streaming = '';
        this.render(reply, { kind: 'working', text: reply.message });
        break;
      case 'tool-start':
        // Text before a tool call is narration. The next message replaces it.
        if (reply) reply.streaming = '';
        break;
      case 'turn-end': {
        live.current = undefined;
        if (reply) {
          const { status: result, text, error } = event.result;
          const partial = reply.streaming || reply.message;
          void this.finish(
            live,
            reply,
            result === 'completed'
              ? { kind: 'completed', text }
              : result === 'interrupted'
                ? { kind: 'stopped', text: partial }
                : { kind: 'failed', text: partial, error: error ?? 'The agent stopped with an error.' },
          );
        }
        if (!live.busy) live.presence.setStatus(undefined);
        break;
      }
      case 'closed':
        live.current = undefined;
        for (const waiting of live.replies.splice(0)) {
          void this.finish(live, waiting, { kind: 'failed', text: '', error: event.error ?? 'The agent closed.' });
        }
        break;
    }
  }

  private async finish(live: LiveSession, reply: Reply, state: ReplyState): Promise<void> {
    if (reply.thread) await this.finishThread(reply.thread, state);
    this.render(reply, state);
    await reply.region?.settled();
    reply.region?.close();
    if (reply.note) {
      const peer = live.presence.peer(reply.note);
      window.setTimeout(() => {
        if (!live.busy) peer.hideCursor();
      }, 1200);
      this.hub.release(reply.note, reply);
    }
  }

  /** Ends a reply into the comments: the final message becomes the agent's comment, and a failure shows in the thread. */
  private async finishThread({ id, file, agent }: NonNullable<Reply['thread']>, state: ReplyState): Promise<void> {
    const { comments } = this.options;
    const name = displayName(this.options.profile(agent) ?? { name: agent });
    if (id === undefined) {
      if (state.kind === 'completed') new Notice(`${name} handled the comments in ${file.basename}.`);
      else if (state.kind === 'failed') new Notice(`${name} could not handle the comments in ${file.basename}: ${state.error.split('\n')[0]}`);
      return;
    }
    if (state.kind === 'completed') {
      comments.setPending(file.path, id, undefined);
      if (state.text.trim()) await comments.addComment(file.path, id, { author: 'agent', agent, text: state.text.trim() });
      return;
    }
    if (state.kind === 'stopped') {
      if (state.text.trim()) await comments.addComment(file.path, id, { author: 'agent', agent, text: state.text.trim() });
      comments.setPending(file.path, id, undefined);
      return;
    }
    if (state.kind === 'failed') comments.setPending(file.path, id, { agent, text: state.text, state: 'failed', error: state.error });
  }

  /** The agent started a turn on its own. Its reply goes to the end of the note. */
  private async followUp(live: LiveSession): Promise<void> {
    const title = `${displayName(live.profile)} (follow-up)`;
    const reply: Reply = { title, note: undefined, region: undefined, streaming: '', message: '', line: undefined };
    if (live.current !== undefined || live.session.closed) return;
    live.current = reply;
    const note = await this.hub.acquire(live.file, reply);
    reply.note = note;
    const end = note.content.length;
    const separator = !note.content || note.content.endsWith('\n\n') ? '' : note.content.endsWith('\n') ? '\n' : '\n\n';
    reply.wrap = (callout) => `${separator}${callout}\n`;
    reply.region = new LiveRegion(live.presence.peer(note), end, end);
    this.render(reply, { kind: 'working', text: '' });
  }

  private render(reply: Reply, state: ReplyState): void {
    if (reply.thread) {
      const { id, file, agent } = reply.thread;
      if (id !== undefined && state.kind === 'working') this.options.comments.setPending(file.path, id, { agent, text: state.text, state: 'working' });
      return;
    }
    if (!reply.region) return;
    const callout = renderCallout(reply.title, state);
    reply.region.set(reply.wrap ? reply.wrap(callout) : callout);
  }
}

/** The request line and the reply callout of a reply, which the agent's view of the note hides. */
function hiddenRange(note: SharedNote, reply: Reply | undefined): { from: number; to: number } | undefined {
  if (!reply?.line || reply.note !== note) return undefined;
  const from = note.absolute(reply.line);
  const range = reply.region?.range;
  return from === undefined || !range ? undefined : { from: Math.min(from, range.from), to: range.to };
}

/** A thread for the agent: its id and line when asked, its passage, and its comments in order. */
function describeThread(thread: Thread, comments: NoteComments, withId: boolean): string {
  const text = passage(comments, thread);
  const attributes = withId ? ` id="${thread.id}"${thread.to > thread.from ? ` line="${lineAt(comments.text, thread.from)}"` : ''}` : '';
  return [
    `<thread${attributes}>`,
    text ? `<passage>\n${text}\n</passage>` : '<passage removed="true" />',
    ...thread.comments.map((comment) => `${comment.author === 'user' ? 'User' : displayName({ name: comment.agent ?? 'agent' })} (${comment.time}): ${comment.text}`),
    '</thread>',
  ].join('\n');
}
