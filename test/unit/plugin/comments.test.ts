import { describe, expect, it } from 'vitest';
import { diffOps } from 'yami/document';
import { applyChange, lineAt, mapRange, openThreads, passage, reconcile, type NoteComments } from '../../../plugin/src/comments/model.ts';

const thread = (from: number, to: number, author: 'user' | 'agent' = 'user') => ({ id: 't', from, to, comments: [{ id: 'c', author, text: 'hi', time: '2026-01-01T00:00:00Z' }] });

describe('mapRange', () => {
  const range = { from: 10, to: 20 };

  it('moves with text inserted or deleted before it', () => {
    expect(mapRange(range, [{ from: 2, to: 2, insert: 'abc' }])).toEqual({ from: 13, to: 23 });
    expect(mapRange(range, [{ from: 2, to: 5, insert: '' }])).toEqual({ from: 7, to: 17 });
  });

  it('stays with text after it', () => {
    expect(mapRange(range, [{ from: 25, to: 30, insert: 'x' }])).toEqual(range);
  });

  it('grows with text inserted inside, and keeps text inserted at its edges outside', () => {
    expect(mapRange(range, [{ from: 15, to: 15, insert: 'abc' }])).toEqual({ from: 10, to: 23 });
    expect(mapRange(range, [{ from: 10, to: 10, insert: 'abc' }])).toEqual({ from: 13, to: 23 });
    expect(mapRange(range, [{ from: 20, to: 20, insert: 'abc' }])).toEqual({ from: 10, to: 20 });
  });

  it('shrinks with text deleted inside', () => {
    expect(mapRange(range, [{ from: 12, to: 15, insert: '' }])).toEqual({ from: 10, to: 17 });
  });

  it('shortens when a change crosses an edge, and leaves the replacement outside', () => {
    expect(mapRange(range, [{ from: 5, to: 15, insert: 'NEW' }])).toEqual({ from: 8, to: 13 });
    expect(mapRange(range, [{ from: 15, to: 25, insert: 'NEW' }])).toEqual({ from: 10, to: 15 });
  });

  it('becomes empty where the text was when all of it is deleted', () => {
    expect(mapRange(range, [{ from: 5, to: 25, insert: '' }])).toEqual({ from: 5, to: 5 });
    expect(mapRange(range, [{ from: 10, to: 20, insert: '' }])).toEqual({ from: 10, to: 10 });
    expect(mapRange(range, [{ from: 5, to: 25, insert: 'NEW' }])).toEqual({ from: 8, to: 8 });
  });

  it('applies several ops in order', () => {
    expect(mapRange(range, [{ from: 0, to: 0, insert: 'ab' }, { from: 12, to: 12, insert: 'cd' }, { from: 30, to: 31, insert: '' }])).toEqual({ from: 12, to: 24 });
  });
});

describe('applyChange', () => {
  const comments: NoteComments = { text: 'one two three four', threads: [thread(4, 7)] };

  it('moves the threads and keeps the new text', () => {
    const next = applyChange(comments, [{ from: 0, to: 3, insert: 'first' }]);
    expect(next.text).toBe('first two three four');
    expect(passage(next, next.threads[0]!)).toBe('two');
    expect(next.threads[0]!.changedBy).toBeUndefined();
  });

  it('records the agent that changed a passage, and not one that changed other text', () => {
    const claude = { name: 'claude', color: '#f00' };
    const elsewhere = applyChange(comments, [{ from: 8, to: 13, insert: 'drei' }], claude);
    expect(elsewhere.threads[0]!.changedBy).toBeUndefined();
    const inside = applyChange(comments, [{ from: 4, to: 7, insert: 'zwei' }], claude);
    expect(passage(inside, inside.threads[0]!)).toBe('zwei');
    expect(inside.threads[0]!.changedBy).toEqual(claude);
    const deletion = applyChange(comments, [{ from: 5, to: 6, insert: '' }], claude);
    expect(deletion.threads[0]!.changedBy).toEqual(claude);
  });

  it('does nothing for no ops', () => {
    expect(applyChange(comments, [])).toBe(comments);
  });
});

describe('reconcile', () => {
  it('follows a change made without Duet', () => {
    const comments: NoteComments = { text: 'alpha beta gamma', threads: [thread(6, 10)] };
    const next = reconcile(comments, 'alpha, then beta gamma', diffOps);
    expect(passage(next, next.threads[0]!)).toBe('beta');
    expect(reconcile(next, next.text, diffOps)).toBe(next);
  });
});

describe('helpers', () => {
  it('finds the line of a position', () => {
    expect(lineAt('a\nb\nc', 0)).toBe(1);
    expect(lineAt('a\nb\nc', 2)).toBe(2);
    expect(lineAt('a\nb\nc', 4)).toBe(3);
  });

  it('lists the threads whose last comment is the person\'s', () => {
    const comments: NoteComments = { text: 'x', threads: [thread(0, 1), { ...thread(0, 1, 'agent'), id: 'a' }, { id: 'e', from: 0, to: 1, comments: [] }] };
    expect(openThreads(comments).map((t) => t.id)).toEqual(['t']);
  });
});
