import { type Extension, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { editorInfoField } from 'obsidian';
import type { Thread } from './model.ts';
import type { CommentStore } from './store.ts';

/** Most time between a change and the refresh that shows it. */
const REFRESH_MS = 120;

const setMarks = StateEffect.define<DecorationSet>();

/** The comment highlights of an editor. They follow edits until the next refresh replaces them. */
const marksField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, transaction) {
    marks = marks.map(transaction.changes);
    for (const effect of transaction.effects) if (effect.is(setMarks)) marks = effect.value;
    return marks;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export interface MarkOptions {
  store: CommentStore;
  /** The color of a thread's highlight: the agent's that changed the passage, or the person's comment color. */
  color(thread: Thread): string;
  /** The thread that the comments view shows, which gets a stronger highlight. */
  active(): string | undefined;
  /** The person clicked a highlight. */
  onClick(path: string, threadId: string): void;
}

/** Highlights the passages of a note that have comment threads. A click on a highlight opens its thread. */
export class CommentMarks {
  readonly views = new Set<MarkView>();

  constructor(readonly options: MarkOptions) {}

  extension(): Extension {
    return [
      marksField,
      ViewPlugin.define((view) => new MarkView(view, this)),
      EditorView.domEventHandlers({
        mousedown: (event, view) => {
          const mark = (event.target as HTMLElement | null)?.closest<HTMLElement>('.duet-comment');
          const path = view.state.field(editorInfoField, false)?.file?.path;
          const thread = mark?.dataset.thread;
          if (path && thread) this.options.onClick(path, thread);
          return false;
        },
      }),
    ];
  }

  /** Updates the highlights of the editors that show `path`, or of all editors. */
  refresh(path?: string): void {
    for (const view of this.views) if (!path || view.path === path) view.schedule(0);
  }

  /** Selects a thread's passage in the editors that show its note, and scrolls to it. */
  reveal(path: string, thread: Thread): void {
    for (const view of this.views) if (view.path === path) view.select(thread);
  }
}

class MarkView {
  private timer: number | undefined;
  private version = 0;

  constructor(
    private readonly view: EditorView,
    private readonly marks: CommentMarks,
  ) {
    marks.views.add(this);
    this.schedule(0);
  }

  get path(): string | undefined {
    return this.view.state.field(editorInfoField, false)?.file?.path;
  }

  update(update: ViewUpdate): void {
    if (update.docChanged) this.schedule();
  }

  schedule(delay = REFRESH_MS): void {
    if (this.timer !== undefined) return;
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      void this.refresh();
    }, delay);
  }

  select(thread: Thread): void {
    const length = this.view.state.doc.length;
    const from = Math.min(thread.from, length);
    const to = Math.min(thread.to, length);
    this.view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
    this.view.focus();
  }

  destroy(): void {
    window.clearTimeout(this.timer);
    this.marks.views.delete(this);
  }

  private async refresh(): Promise<void> {
    const version = ++this.version;
    const path = this.path;
    if (!path) return;
    const text = this.view.state.doc.toString();
    const { threads } = await this.marks.options.store.comments(path, text);
    // A newer refresh or a newer text replaces this one.
    if (version !== this.version || !this.view.dom.isConnected || this.view.state.doc.toString() !== text) return;
    const active = this.marks.options.active();
    const ranges = threads
      .filter((thread) => thread.to > thread.from)
      .map((thread) =>
        Decoration.mark({
          class: thread.id === active ? 'duet-comment is-active' : 'duet-comment',
          attributes: { style: `--duet-comment: ${this.marks.options.color(thread)}`, 'data-thread': thread.id },
        }).range(thread.from, thread.to),
      );
    this.view.dispatch({ effects: setMarks.of(Decoration.set(ranges, true)) });
  }
}
