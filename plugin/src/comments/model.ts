import { applyOps, type TextOp } from 'yami/document';
import { changedRanges } from '../contributions/spans.ts';

/** One comment of a thread. */
export interface Comment {
  id: string;
  /** `user` for the person, `agent` for a Duet agent. */
  author: 'user' | 'agent';
  /** The agent's tag, for a comment of an agent. */
  agent?: string;
  text: string;
  /** When the comment was written, as an ISO date. */
  time: string;
  /** When the comment was last edited, as an ISO date. */
  edited?: string;
}

/** A conversation on one passage of a note. */
export interface Thread {
  id: string;
  /** The passage, as a character range of the note. Empty when the passage was removed. */
  from: number;
  to: number;
  comments: Comment[];
  /** The Duet agent that last changed the passage, with its color then. The highlight takes that color. */
  changedBy?: { name: string; color: string };
}

/** The threads of a note and the text that their ranges refer to. */
export interface NoteComments {
  text: string;
  threads: Thread[];
}

/**
 * Moves a range through ascending, non-overlapping ops. Text inserted inside the range joins it; text
 * inserted at either edge stays outside. Text deleted across an edge shortens the range, and a replacement
 * across an edge stays outside. A range whose text is all deleted becomes empty where the text was.
 */
export function mapRange(range: { from: number; to: number }, ops: TextOp[]): { from: number; to: number } {
  const from = mapPoint(range.from, ops, 'from');
  return { from, to: Math.max(from, mapPoint(range.to, ops, 'to')) };
}

function mapPoint(position: number, ops: TextOp[], side: 'from' | 'to'): number {
  let shift = 0;
  for (const op of ops) {
    if (op.to < position || (op.to === position && (op.from < position || side === 'from'))) {
      shift += op.insert.length - (op.to - op.from);
      continue;
    }
    // The op deletes the text around the position: the start lands after the replacement, the end before it.
    if (op.from < position) return op.from + shift + (side === 'from' ? op.insert.length : 0);
    break;
  }
  return position + shift;
}

/**
 * Applies ops to the comments of a note. The threads' ranges follow the ops. With `agent`, a thread whose
 * passage the ops touch records the agent as the one that changed it.
 */
export function applyChange(comments: NoteComments, ops: TextOp[], agent?: { name: string; color: string }): NoteComments {
  if (!ops.length) return comments;
  const text = applyOps(comments.text, ops);
  const changed = changedRanges(ops);
  const threads = comments.threads.map((thread) => {
    const range = mapRange(thread, ops);
    const touched = agent && changed.some((change) => (change.from === change.to ? change.from > range.from && change.from < range.to : change.from < range.to && change.to > range.from));
    return { ...thread, ...range, ...(touched && { changedBy: { ...agent } }) };
  });
  return { text, threads };
}

/** Brings the comments up to date with a text that changed without Duet, by comparing the texts. */
export function reconcile(comments: NoteComments, text: string, diff: (before: string, after: string) => TextOp[]): NoteComments {
  if (comments.text === text) return comments;
  return applyChange(comments, diff(comments.text, text));
}

/** The passage of a thread in the text, or an empty string when it was removed. */
export function passage(comments: NoteComments, thread: Thread): string {
  return comments.text.slice(thread.from, thread.to);
}

/** The one-based line of a position in the text. */
export function lineAt(text: string, position: number): number {
  let line = 1;
  for (let index = text.indexOf('\n'); index >= 0 && index < position; index = text.indexOf('\n', index + 1)) line++;
  return line;
}

/** The threads that wait for an answer: the last comment is the person's. */
export function openThreads(comments: NoteComments): Thread[] {
  return comments.threads.filter((thread) => thread.comments.length && thread.comments.at(-1)!.author === 'user');
}

/** The name of an author as the view shows it: the agent's tag with a capital, as the reply callouts do. */
export function displayAuthor(tag: string): string {
  return tag.charAt(0).toUpperCase() + tag.slice(1);
}
