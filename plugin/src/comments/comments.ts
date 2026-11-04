import { type Editor, MarkdownView, Notice, type TFile } from 'obsidian';
import { findTags } from '../mention.ts';
import type { MentionAgents } from '../mentions.ts';
import type { AgentProfile } from '../settings.ts';
import type DuetPlugin from '../main.ts';
import { CommentMarks } from './marks.ts';
import { type Comment, displayAuthor, type NoteComments, openThreads, type Thread } from './model.ts';
import { CommentStore } from './store.ts';
import { COMMENTS_VIEW, CommentsView } from './view.ts';

/**
 * Comments on highlighted passages of a note. The store keeps them, the marks show them in the editor, the
 * view lists them in the sidebar, and a comment that tags an agent runs it on the passage.
 */
export class Comments {
  readonly store: CommentStore;
  readonly marks: CommentMarks;
  private readonly agentCommands = new Set<string>();

  constructor(
    private readonly plugin: DuetPlugin,
    private readonly mentions: () => MentionAgents,
  ) {
    this.store = new CommentStore(plugin.app);
    this.marks = new CommentMarks({
      store: this.store,
      color: (thread) => this.color(thread),
      active: () => this.view()?.activeThread,
      onClick: (path, threadId) => void this.open(path, threadId, false),
    });
  }

  install(): void {
    const { plugin } = this;
    const { app } = plugin;
    this.store.install(plugin);
    plugin.yami.hub.observe(this.store);
    this.store.onChange((path) => this.marks.refresh(path));
    plugin.registerEditorExtension(this.marks.extension());
    plugin.registerView(
      COMMENTS_VIEW,
      (leaf) =>
        new CommentsView(leaf, {
          store: this.store,
          agentName: (tag) => displayAuthor(tag),
          color: (thread) => this.color(thread),
          agentTags: () => plugin.settings.profiles.map((profile) => profile.name),
          onComment: (path, thread, comment, comments) => this.posted(path, thread, comment, comments),
          reveal: (path, thread) => this.marks.reveal(path, thread),
          onActiveChange: (path) => this.marks.refresh(path),
        }),
    );
    plugin.registerEvent(
      app.workspace.on('editor-menu', (menu, editor, info) => {
        if (!editor.somethingSelected() || !info.file) return;
        const file = info.file;
        menu.addItem((item) =>
          item
            .setTitle('Add comment')
            .setIcon('message-square-plus')
            .onClick(() => void this.add(editor, file)),
        );
      }),
    );
    plugin.addCommand({
      id: 'add-comment',
      name: 'Add a comment on the selection',
      editorCheckCallback: (checking, editor, view) => {
        if (!editor.somethingSelected() || !view.file) return false;
        if (!checking) void this.add(editor, view.file);
        return true;
      },
    });
    plugin.addCommand({
      id: 'open-comments',
      name: 'Open the comments of this note',
      checkCallback: (checking) => {
        const file = app.workspace.getActiveViewOfType(MarkdownView)?.file;
        if (!file) return false;
        if (!checking) void this.open(file.path);
        return true;
      },
    });
    this.syncAgentCommands();
  }

  /** One command for each agent, which has it handle every open comment of the note. Call it when the agents change. */
  syncAgentCommands(): void {
    const { plugin } = this;
    const names = new Set(plugin.settings.profiles.map((profile) => profile.name));
    for (const name of this.agentCommands) {
      if (!names.has(name)) {
        plugin.removeCommand(`handle-comments-${name}`);
        this.agentCommands.delete(name);
      }
    }
    for (const profile of plugin.settings.profiles) {
      if (this.agentCommands.has(profile.name)) continue;
      this.agentCommands.add(profile.name);
      plugin.addCommand({
        id: `handle-comments-${profile.name}`,
        name: `Let ${displayAuthor(profile.name)} handle the comments in this note`,
        checkCallback: (checking) => {
          const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
          const current = plugin.settings.profiles.find((candidate) => candidate.name === profile.name);
          if (!view?.file || !current) return false;
          if (!checking) void this.handleAll(view.file, view.editor.getValue(), current);
          return true;
        },
      });
    }
  }

  /** The highlight color of a thread: the agent's that changed the passage, or the person's comment color. */
  color(thread: Thread): string {
    if (!thread.changedBy) return this.plugin.settings.commentColor;
    return this.plugin.settings.profiles.find((profile) => profile.name === thread.changedBy!.name)?.color ?? thread.changedBy.color;
  }

  /** Writes the records that wait to be saved. */
  flush(): Promise<void> {
    return this.store.flush();
  }

  /** Starts a thread on the editor's selection and opens it in the view, with the focus in its comment box. */
  private async add(editor: Editor, file: TFile): Promise<void> {
    const from = editor.posToOffset(editor.getCursor('from'));
    const to = editor.posToOffset(editor.getCursor('to'));
    if (to <= from) return;
    const thread = await this.store.addThread(file.path, editor.getValue(), { from, to });
    await this.open(file.path, thread.id, true);
  }

  /** Shows the comments of a note in the sidebar, and a thread when given, with the focus in its reply box when `focus`. */
  private async open(path: string, threadId?: string, focus = false): Promise<void> {
    const { workspace } = this.plugin.app;
    let leaf = workspace.getLeavesOfType(COMMENTS_VIEW)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) ?? undefined;
      if (!leaf) return;
      await leaf.setViewState({ type: COMMENTS_VIEW, active: true });
    }
    await workspace.revealLeaf(leaf);
    if (leaf.view instanceof CommentsView) leaf.view.show(path, threadId, focus);
  }

  private view(): CommentsView | undefined {
    const view = this.plugin.app.workspace.getLeavesOfType(COMMENTS_VIEW)[0]?.view;
    return view instanceof CommentsView ? view : undefined;
  }

  /** The person posted a comment. A tag of an agent in it runs the agent on the passage. */
  private posted(path: string, thread: Thread, comment: Comment, comments: NoteComments): void {
    const names = this.plugin.settings.profiles.map((profile) => profile.name);
    const tag = findTags(comment.text, names)[0];
    const profile = tag && this.plugin.settings.profiles.find((candidate) => candidate.name === tag.name);
    const file = this.plugin.app.vault.getFileByPath(path);
    if (!profile || !file) return;
    void this.mentions().askInThread({ file, profile, thread, comments });
  }

  private async handleAll(file: TFile, text: string, profile: AgentProfile): Promise<void> {
    const comments = await this.store.comments(file.path, text);
    const threads = openThreads(comments);
    if (!threads.length) {
      new Notice(`No comment in ${file.basename} waits for an answer.`);
      return;
    }
    await this.mentions().handleThreads({ file, profile, threads, comments });
  }
}
