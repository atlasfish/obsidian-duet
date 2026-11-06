import { type App, normalizePath, type Plugin, TFile } from 'obsidian';
import { diffOps } from 'yami/document';
import type { HubObserver, NoteChange, SharedNote } from 'yami/obsidian';
import { applyChange, type Comment, type NoteComments, reconcile, type Thread } from './model.ts';

/** Folder of the comment files, in the vault. One JSON file for each note, at the note's path. */
export const COMMENTS_FOLDER = '.duet/comments';
const VERSION = 1;
const SAVE_DELAY_MS = 1000;

interface CommentsFile {
  version: number;
  /** The note text that the ranges refer to. */
  text: string;
  threads: Thread[];
}

/** A reply that an agent writes into a thread now. It is not saved; the view shows it under the thread. */
export interface PendingReply {
  agent: string;
  text: string;
  state: 'working' | 'failed';
  error?: string;
}

interface SharedEntry {
  live: boolean;
  queue: Promise<NoteRecord | undefined>;
}

class NoteRecord {
  /** Shared notes that change the record now. Only they may move its ranges. */
  attached = 0;

  constructor(
    public path: string,
    public comments: NoteComments,
  ) {}
}

export function commentsPath(notePath: string): string {
  return normalizePath(`${COMMENTS_FOLDER}/${notePath}.json`);
}

export const newId = (): string => Math.random().toString(36).slice(2, 10);

/**
 * Keeps the comment threads of each note. A thread's range follows every change of a shared note exactly.
 * Changes that Duet does not see, for example while Obsidian is closed, are found by comparing the stored
 * text with the note text the next time the record is read.
 */
export class CommentStore implements HubObserver {
  private readonly records = new Map<string, Promise<NoteRecord | undefined>>();
  private readonly saves = new Map<NoteRecord, number>();
  private readonly listeners = new Set<(path: string) => void>();
  private readonly attached = new Map<SharedNote, SharedEntry>();
  private readonly pending = new Map<string, Map<string, PendingReply>>();

  constructor(private readonly app: App) {}

  install(plugin: Plugin): void {
    plugin.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (file instanceof TFile) void this.rename(oldPath, file.path);
      }),
    );
    plugin.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (file instanceof TFile) void this.remove(file.path);
      }),
    );
  }

  /** Calls `listener` with a note's path after its comments change. */
  onChange(listener: (path: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The comments of a note whose text is `text`, with their ranges in that text. */
  async comments(path: string, text: string): Promise<NoteComments> {
    const record = await this.load(path);
    if (!record) return { text, threads: [] };
    // A shared note moves the ranges itself. Map them for this caller without changing the record.
    if (record.attached) return applyChange(record.comments, diffOps(record.comments.text, text));
    if (record.comments.text !== text) {
      record.comments = reconcile(record.comments, text, diffOps);
      this.scheduleSave(record);
    }
    return record.comments;
  }

  /** Starts a thread on a range of the note, whose text is `text`. The thread has no comment yet. */
  async addThread(path: string, text: string, range: { from: number; to: number }): Promise<Thread> {
    const record = await this.edit(path, text);
    const thread: Thread = { id: newId(), from: range.from, to: range.to, comments: [] };
    record.comments = { ...record.comments, threads: [...record.comments.threads, thread].sort((a, b) => a.from - b.from) };
    this.recorded(record);
    return thread;
  }

  async addComment(path: string, threadId: string, comment: Omit<Comment, 'id' | 'time'>): Promise<Comment | undefined> {
    const added: Comment = { id: newId(), time: new Date().toISOString(), ...comment };
    const done = await this.change(path, threadId, (thread) => ({ ...thread, comments: [...thread.comments, added] }));
    return done ? added : undefined;
  }

  editComment(path: string, threadId: string, commentId: string, text: string): Promise<boolean> {
    return this.change(path, threadId, (thread) => ({
      ...thread,
      comments: thread.comments.map((comment) => (comment.id === commentId ? { ...comment, text, edited: new Date().toISOString() } : comment)),
    }));
  }

  /** Removes a comment. A thread with no comment left goes too. */
  removeComment(path: string, threadId: string, commentId: string): Promise<boolean> {
    return this.change(path, threadId, (thread) => {
      const comments = thread.comments.filter((comment) => comment.id !== commentId);
      return comments.length ? { ...thread, comments } : undefined;
    });
  }

  removeThread(path: string, threadId: string): Promise<boolean> {
    return this.change(path, threadId, () => undefined);
  }

  /** The reply that an agent writes into a thread now, or none. The view shows it; it is not saved. */
  setPending(path: string, threadId: string, reply: PendingReply | undefined): void {
    let replies = this.pending.get(path);
    if (reply) {
      if (!replies) this.pending.set(path, (replies = new Map<string, PendingReply>()));
      replies.set(threadId, reply);
    } else if (replies) {
      replies.delete(threadId);
      if (!replies.size) this.pending.delete(path);
    }
    for (const listener of this.listeners) listener(path);
  }

  pendingReplies(path: string): ReadonlyMap<string, PendingReply> {
    return this.pending.get(path) ?? new Map();
  }

  /** Records the changes of a shared note until the returned function runs. */
  shared(note: SharedNote): () => void {
    const text = note.content;
    const entry: SharedEntry = {
      live: true,
      queue: this.load(note.path).then((record) => {
        if (record) {
          record.attached++;
          record.comments = reconcile(record.comments, text, diffOps);
        }
        return record;
      }),
    };
    this.attached.set(note, entry);
    return () => {
      this.attached.delete(note);
      entry.live = false;
      entry.queue = entry.queue.then((record) => {
        if (record) record.attached = Math.max(0, record.attached - 1);
        return record;
      });
    };
  }

  changed({ note, ops, agent }: NoteChange): void {
    const entry = this.attached.get(note);
    if (!entry || !ops.length) return;
    entry.queue = entry.queue.then((record) => {
      if (!record) return record;
      record.comments = applyChange(record.comments, ops, agent && { name: agent.name, color: agent.color });
      this.recorded(record);
      return record;
    });
  }

  /** Writes the records that wait to be saved. */
  async flush(): Promise<void> {
    const pending = [...this.saves];
    this.saves.clear();
    for (const [record, timer] of pending) {
      window.clearTimeout(timer);
      await this.save(record);
    }
  }

  /** Changes one thread, or removes it when `change` gives none. False when the note or the thread is unknown. */
  private async change(path: string, threadId: string, change: (thread: Thread) => Thread | undefined): Promise<boolean> {
    const record = await this.load(path);
    const thread = record?.comments.threads.find((candidate) => candidate.id === threadId);
    if (!record || !thread) return false;
    const changed = change(thread);
    record.comments = { ...record.comments, threads: record.comments.threads.flatMap((candidate) => (candidate === thread ? (changed ? [changed] : []) : [candidate])) };
    this.recorded(record);
    return true;
  }

  /** The record of a note, brought up to date with `text`, for a change by the person. */
  private async edit(path: string, text: string): Promise<NoteRecord> {
    const record = (await this.load(path)) ?? this.add(path, { text, threads: [] });
    if (!record.attached && record.comments.text !== text) record.comments = reconcile(record.comments, text, diffOps);
    return record;
  }

  private add(path: string, comments: NoteComments): NoteRecord {
    const record = new NoteRecord(path, comments);
    this.records.set(path, Promise.resolve(record));
    return record;
  }

  private recorded(record: NoteRecord): void {
    this.scheduleSave(record);
    for (const listener of this.listeners) listener(record.path);
  }

  private load(path: string): Promise<NoteRecord | undefined> {
    let record = this.records.get(path);
    if (!record) {
      record = this.read(path);
      this.records.set(path, record);
    }
    return record;
  }

  private async read(path: string): Promise<NoteRecord | undefined> {
    const adapter = this.app.vault.adapter;
    const file = commentsPath(path);
    try {
      if (!(await adapter.exists(file))) return undefined;
      const data = JSON.parse(await adapter.read(file)) as Partial<CommentsFile>;
      if (data.version !== VERSION || typeof data.text !== 'string' || !Array.isArray(data.threads)) return undefined;
      const threads = data.threads.filter(
        (thread): thread is Thread =>
          typeof thread.id === 'string' &&
          Number.isInteger(thread.from) &&
          Number.isInteger(thread.to) &&
          thread.from >= 0 &&
          thread.to >= thread.from &&
          thread.to <= data.text!.length &&
          Array.isArray(thread.comments) &&
          thread.comments.length > 0,
      );
      return new NoteRecord(path, { text: data.text, threads });
    } catch (error) {
      console.error(`Duet: could not read the comments of ${path}`, error);
      return undefined;
    }
  }

  private scheduleSave(record: NoteRecord): void {
    window.clearTimeout(this.saves.get(record));
    this.saves.set(
      record,
      window.setTimeout(() => {
        this.saves.delete(record);
        void this.save(record);
      }, SAVE_DELAY_MS),
    );
  }

  /** Writes a record, or removes its file when no thread with a comment is left. A thread without a comment is a draft. */
  private async save(record: NoteRecord): Promise<void> {
    const adapter = this.app.vault.adapter;
    const file = commentsPath(record.path);
    try {
      const threads = record.comments.threads.filter((thread) => thread.comments.length);
      if (!threads.length) {
        if (await adapter.exists(file)) await adapter.remove(file);
        return;
      }
      await this.ensureFolder(file);
      const data: CommentsFile = { version: VERSION, text: record.comments.text, threads };
      await adapter.write(file, JSON.stringify(data, null, 1));
    } catch (error) {
      console.error(`Duet: could not save the comments of ${record.path}`, error);
    }
  }

  private async rename(oldPath: string, newPath: string): Promise<void> {
    const record = await this.load(oldPath);
    this.records.delete(oldPath);
    const pending = this.pending.get(oldPath);
    if (pending) {
      this.pending.delete(oldPath);
      this.pending.set(newPath, pending);
    }
    if (!record) return;
    record.path = newPath;
    this.records.set(newPath, Promise.resolve(record));
    await this.save(record);
    const old = commentsPath(oldPath);
    if (await this.app.vault.adapter.exists(old)) await this.app.vault.adapter.remove(old);
    for (const listener of this.listeners) listener(newPath);
  }

  private async remove(path: string): Promise<void> {
    const record = await this.records.get(path);
    this.records.delete(path);
    this.pending.delete(path);
    if (record) {
      window.clearTimeout(this.saves.get(record));
      this.saves.delete(record);
    }
    const file = commentsPath(path);
    if (await this.app.vault.adapter.exists(file)) await this.app.vault.adapter.remove(file);
  }

  private async ensureFolder(file: string): Promise<void> {
    const folder = file.slice(0, file.lastIndexOf('/'));
    if (folder && !(await this.app.vault.adapter.exists(folder))) await this.app.vault.adapter.mkdir(folder);
  }
}
