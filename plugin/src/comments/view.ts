import { Component, ItemView, MarkdownRenderer, MarkdownView, Menu, setIcon, setTooltip, TFile, type WorkspaceLeaf } from 'obsidian';
import { age } from 'yami/obsidian';
import { type Comment, type NoteComments, passage, type Thread } from './model.ts';
import type { CommentStore, PendingReply } from './store.ts';

export const COMMENTS_VIEW = 'duet-comments';
/** Most characters of a passage that a thread shows. */
const EXCERPT = 120;

export interface CommentsViewOptions {
  store: CommentStore;
  /** The display name of an agent's tag, for example `Claude`. */
  agentName(tag: string): string;
  /** The color of a thread's highlight. */
  color(thread: Thread): string;
  /** The tags of the agents, for the placeholder of the reply box. */
  agentTags(): string[];
  /** The person posted a comment. The host runs an agent when the comment tags one. */
  onComment(path: string, thread: Thread, comment: Comment, comments: NoteComments): void;
  /** The person wants to see a thread's passage in the note. */
  reveal(path: string, thread: Thread): void;
  /** The thread that the view shows changed, so the editors restyle their highlights. */
  onActiveChange(path: string | undefined): void;
}

/**
 * The comment threads of the open note, in the right sidebar. Each thread shows its passage, its comments,
 * and a reply box. The person edits and removes their own comments, removes any comment or thread, and
 * starts an agent by tagging it in a comment.
 */
export class CommentsView extends ItemView {
  /** The note whose comments the view shows. It follows the active note. */
  path: string | undefined;
  /** The thread that the person opened, with a stronger highlight in the note. */
  activeThread: string | undefined;
  private comments: NoteComments = { text: '', threads: [] };
  private readonly drafts = new Map<string, string>();
  private editing: string | undefined;
  private version = 0;
  /** The rendered Markdown of the comments, unloaded at each render. */
  private rendered = new Component();

  constructor(
    leaf: WorkspaceLeaf,
    private readonly options: CommentsViewOptions,
  ) {
    super(leaf);
    this.navigation = false;
  }

  getViewType(): string {
    return COMMENTS_VIEW;
  }

  getDisplayText(): string {
    return 'Comments';
  }

  getIcon(): string {
    return 'message-square-text';
  }

  override onOpen(): Promise<void> {
    this.contentEl.addClass('duet-comments');
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.follow()));
    this.registerEvent(this.app.workspace.on('file-open', () => this.follow()));
    this.registerEvent(this.app.workspace.on('editor-change', (_editor, info) => {
      if (info.file?.path === this.path) this.scheduleReload();
    }));
    this.register(this.options.store.onChange((path) => {
      if (path === this.path) void this.reload();
    }));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      if (file instanceof TFile && oldPath === this.path) this.show(file.path);
    }));
    this.follow();
    return Promise.resolve();
  }

  override onClose(): Promise<void> {
    this.setActive(undefined);
    return Promise.resolve();
  }

  /** Shows a note's comments. With a thread, opens it, and with `focus`, puts the focus in its reply box. */
  show(path: string, threadId?: string, focus = false): void {
    const changed = path !== this.path;
    this.path = path;
    if (threadId !== undefined) this.setActive(threadId);
    void this.reload().then(() => {
      if (threadId !== undefined) this.focusReply(threadId, undefined, focus);
      else if (changed) this.contentEl.scrollTo({ top: 0 });
    });
  }

  private follow(): void {
    const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
    if (file && file.path !== this.path) {
      this.setActive(undefined);
      this.show(file.path);
    } else if (!file && !this.path) {
      this.render();
    }
  }

  private setActive(threadId: string | undefined): void {
    if (this.activeThread === threadId) return;
    this.activeThread = threadId;
    this.options.onActiveChange(this.path);
  }

  private timer: number | undefined;
  private scheduleReload(): void {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.reload(), 200);
  }

  /** The current text of the note: the editor's when one shows it, else the file's. */
  private async text(path: string): Promise<string | undefined> {
    let text: string | undefined;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (text === undefined && leaf.view instanceof MarkdownView && leaf.view.file?.path === path) text = leaf.view.editor.getValue();
    });
    if (text !== undefined) return text;
    const file = this.app.vault.getFileByPath(path);
    return file ? this.app.vault.cachedRead(file) : undefined;
  }

  private async reload(): Promise<void> {
    const version = ++this.version;
    const path = this.path;
    if (!path) return this.render();
    const text = await this.text(path);
    if (version !== this.version) return;
    if (text === undefined) {
      this.path = undefined;
      return this.render();
    }
    this.comments = await this.options.store.comments(path, text);
    if (version !== this.version) return;
    this.render();
  }

  private render(): void {
    const root = this.contentEl;
    const focused = root.doc.activeElement;
    const focusedThread = focused instanceof HTMLTextAreaElement ? focused.dataset.thread : undefined;
    const caret = focused instanceof HTMLTextAreaElement ? focused.selectionStart : undefined;
    this.removeChild(this.rendered);
    this.rendered = this.addChild(new Component());
    root.empty();
    const path = this.path;
    if (!path) {
      root.createDiv({ cls: 'duet-comments-empty', text: 'Open a note to see its comments.' });
      return;
    }
    const header = root.createDiv({ cls: 'duet-comments-header' });
    header.createDiv({ cls: 'duet-comments-title', text: path.replace(/\.md$/, '').split('/').pop() ?? path });
    const count = this.comments.threads.filter((thread) => thread.comments.length).length;
    header.createDiv({ cls: 'duet-comments-count', text: count === 1 ? '1 thread' : `${count} threads` });
    if (!this.comments.threads.length) {
      root.createDiv({ cls: 'duet-comments-empty', text: 'No comments yet. Select text in the note and choose Add comment.' });
      return;
    }
    const pending = this.options.store.pendingReplies(path);
    for (const thread of this.comments.threads) this.renderThread(root, path, thread, pending.get(thread.id));
    if (focusedThread) this.focusReply(focusedThread, caret);
  }

  private renderThread(root: HTMLElement, path: string, thread: Thread, pending: PendingReply | undefined): void {
    const card = root.createDiv({ cls: 'duet-thread' });
    card.dataset.thread = thread.id;
    card.style.setProperty('--duet-comment', this.options.color(thread));
    card.toggleClass('is-active', thread.id === this.activeThread);
    card.toggleClass('is-draft', !thread.comments.length);
    card.addEventListener('mousedown', () => this.setActive(thread.id));

    const head = card.createDiv({ cls: 'duet-thread-head' });
    const text = passage(this.comments, thread);
    if (text) {
      const quote = head.createDiv({ cls: 'duet-thread-passage', text: text.length > EXCERPT ? `${text.slice(0, EXCERPT).trimEnd()}…` : text });
      setTooltip(quote, 'Show in the note');
      quote.addEventListener('click', () => this.options.reveal(path, thread));
    } else {
      head.createDiv({ cls: 'duet-thread-passage is-gone', text: 'The passage was removed from the note.' });
    }
    if (thread.changedBy) {
      const changed = head.createDiv({ cls: 'duet-thread-changed', text: `Changed by ${this.options.agentName(thread.changedBy.name)}` });
      setTooltip(changed, 'The agent changed this passage, so the highlight has its color.');
    }
    const remove = head.createEl('button', { cls: 'clickable-icon duet-thread-remove' });
    setIcon(remove, 'trash-2');
    setTooltip(remove, 'Remove the thread');
    remove.addEventListener('click', () => void this.removeThread(path, thread));

    for (const comment of thread.comments) this.renderComment(card, path, thread, comment);
    if (pending) this.renderPending(card, pending);
    this.renderReply(card, path, thread);
  }

  private renderComment(card: HTMLElement, path: string, thread: Thread, comment: Comment): void {
    const item = card.createDiv({ cls: `duet-comment-item is-${comment.author}` });
    const head = item.createDiv({ cls: 'duet-comment-head' });
    head.createSpan({ cls: 'duet-comment-author', text: comment.author === 'user' ? 'You' : this.options.agentName(comment.agent ?? 'agent') });
    const when = head.createSpan({ cls: 'duet-comment-time', text: comment.edited ? `${age(comment.time)}, edited` : age(comment.time) });
    setTooltip(when, new Date(comment.edited ?? comment.time).toLocaleString());
    const more = head.createEl('button', { cls: 'clickable-icon duet-comment-more' });
    setIcon(more, 'ellipsis');
    setTooltip(more, 'More');
    more.addEventListener('click', (event) => {
      const menu = new Menu();
      if (comment.author === 'user') {
        menu.addItem((item) =>
          item
            .setTitle('Edit')
            .setIcon('pencil')
            .onClick(() => {
              this.editing = comment.id;
              this.render();
            }),
        );
      }
      menu.addItem((item) =>
        item
          .setTitle('Remove')
          .setIcon('trash-2')
          .onClick(() => void this.options.store.removeComment(path, thread.id, comment.id)),
      );
      menu.showAtMouseEvent(event);
    });

    if (this.editing === comment.id) {
      const box = item.createEl('textarea', { cls: 'duet-comment-edit', text: comment.text });
      box.rows = Math.min(8, Math.max(2, comment.text.split('\n').length));
      const save = () => {
        const text = box.value.trim();
        this.editing = undefined;
        if (text && text !== comment.text) void this.options.store.editComment(path, thread.id, comment.id, text);
        else this.render();
      };
      box.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          save();
        } else if (event.key === 'Escape') {
          this.editing = undefined;
          this.render();
        }
      });
      const actions = item.createDiv({ cls: 'duet-comment-actions' });
      actions.createEl('button', { text: 'Save', cls: 'mod-cta' }).addEventListener('click', save);
      actions.createEl('button', { text: 'Cancel' }).addEventListener('click', () => {
        this.editing = undefined;
        this.render();
      });
      window.setTimeout(() => box.focus());
      return;
    }
    const body = item.createDiv({ cls: 'duet-comment-body' });
    void MarkdownRenderer.render(this.app, comment.text, body, path, this.rendered);
  }

  private renderPending(card: HTMLElement, pending: PendingReply): void {
    const item = card.createDiv({ cls: `duet-comment-item is-agent is-pending${pending.state === 'failed' ? ' is-failed' : ''}` });
    const head = item.createDiv({ cls: 'duet-comment-head' });
    head.createSpan({ cls: 'duet-comment-author', text: this.options.agentName(pending.agent) });
    head.createSpan({ cls: `duet-comment-time duet-status${pending.state === 'working' ? ' is-working' : ''}`, text: pending.state === 'working' ? 'working' : 'failed' });
    const body = item.createDiv({ cls: 'duet-comment-body' });
    if (pending.text) body.setText(pending.text);
    if (pending.error) body.createDiv({ cls: 'duet-comment-error', text: pending.error.split('\n')[0]! });
  }

  private renderReply(card: HTMLElement, path: string, thread: Thread): void {
    const draft = !thread.comments.length;
    const form = card.createDiv({ cls: 'duet-reply' });
    const box = form.createEl('textarea', { cls: 'duet-reply-box' });
    box.dataset.thread = thread.id;
    box.rows = draft ? 2 : 1;
    const tags = this.options.agentTags();
    box.placeholder = draft
      ? tags.length
        ? `Comment, or @${tags[0]} to ask the agent`
        : 'Comment'
      : tags.length
        ? `Reply, or @${tags[0]} to ask the agent`
        : 'Reply';
    box.value = this.drafts.get(thread.id) ?? '';
    const grow = () => {
      box.rows = Math.min(10, Math.max(draft ? 2 : 1, box.value.split('\n').length));
    };
    grow();
    box.addEventListener('input', () => {
      this.drafts.set(thread.id, box.value);
      grow();
    });
    const post = () => void this.post(path, thread, box.value);
    box.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        post();
      } else if (event.key === 'Escape' && draft) {
        void this.removeThread(path, thread);
      }
    });
    const actions = form.createDiv({ cls: 'duet-comment-actions' });
    const send = actions.createEl('button', { text: draft ? 'Comment' : 'Reply', cls: 'mod-cta' });
    send.addEventListener('click', post);
    if (draft) {
      actions.createEl('button', { text: 'Cancel' }).addEventListener('click', () => void this.removeThread(path, thread));
    }
  }

  private async post(path: string, thread: Thread, value: string): Promise<void> {
    const text = value.trim();
    if (!text) return;
    this.drafts.delete(thread.id);
    this.options.store.setPending(path, thread.id, undefined);
    const comment = await this.options.store.addComment(path, thread.id, { author: 'user', text });
    if (!comment) return;
    const updated = { ...thread, comments: [...thread.comments, comment] };
    this.options.onComment(path, updated, comment, { ...this.comments, threads: this.comments.threads.map((t) => (t.id === thread.id ? updated : t)) });
  }

  private async removeThread(path: string, thread: Thread): Promise<void> {
    this.drafts.delete(thread.id);
    if (this.activeThread === thread.id) this.setActive(undefined);
    await this.options.store.removeThread(path, thread.id);
  }

  private focusReply(threadId: string, caret?: number, focus = true): void {
    const box = this.contentEl.querySelector<HTMLTextAreaElement>(`.duet-reply-box[data-thread="${threadId}"]`);
    if (!box) return;
    if (focus) {
      box.focus();
      if (caret !== undefined) box.setSelectionRange(caret, caret);
    }
    box.closest('.duet-thread')?.scrollIntoView({ block: 'nearest' });
  }
}
