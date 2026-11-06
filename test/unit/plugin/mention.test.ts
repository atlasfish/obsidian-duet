import { describe, expect, it } from 'vitest';
import { findMention, findTags } from '../../../plugin/src/mention.ts';

const NAMES = ['claude', 'codex', 'work'];

describe('findMention', () => {
  it('finds a tag at the start of a line', () => {
    expect(findMention('@claude summarize this note', NAMES)).toEqual({ name: 'claude', prompt: 'summarize this note' });
  });

  it('finds a tag after other text and keeps everything after it', () => {
    expect(findMention('Draft intro. @codex: shorten the intro, please', NAMES)).toEqual({
      name: 'codex',
      prompt: 'shorten the intro, please',
    });
  });

  it('matches names without regard to case and returns the configured name', () => {
    expect(findMention('- [ ] @Claude check the links', NAMES)?.name).toBe('claude');
  });

  it('needs a request after the tag', () => {
    expect(findMention('@claude', NAMES)).toBeUndefined();
    expect(findMention('@claude   ', NAMES)).toBeUndefined();
  });

  it('ignores email addresses, longer names and unknown names', () => {
    expect(findMention('mail ana@claude.ai about it', NAMES)).toBeUndefined();
    expect(findMention('@claudette do this', NAMES)).toBeUndefined();
    expect(findMention('@work-notes do this', NAMES)).toBeUndefined();
    expect(findMention('@gemini do this', NAMES)).toBeUndefined();
  });

  it('ignores blockquotes and callouts', () => {
    expect(findMention('> @claude do this', NAMES)).toBeUndefined();
    expect(findMention('  > [!agent]+ Claude @claude do this', NAMES)).toBeUndefined();
  });
});

describe('findTags', () => {
  it('finds each tag of a configured agent, with its range', () => {
    expect(findTags('@claude ask @Codex too', NAMES)).toEqual([
      { name: 'claude', from: 0, to: 7 },
      { name: 'codex', from: 12, to: 18 },
    ]);
  });

  it('finds a tag before the request is typed', () => {
    expect(findTags('Draft (@work', NAMES)).toEqual([{ name: 'work', from: 7, to: 12 }]);
  });

  it('ignores email addresses, longer names and quoted lines', () => {
    expect(findTags('ana@claude.ai @claudette @work-notes', NAMES)).toEqual([]);
    expect(findTags('> @claude in a quote', NAMES)).toEqual([]);
  });
});

describe('findMention with several tags', () => {
  it('uses the first tag that a request follows', () => {
    expect(findMention('Ping @claude. @codex do this', NAMES)).toEqual({ name: 'codex', prompt: 'do this' });
  });
});

describe('tags with a skill', () => {
  it('finds the skill after the slash and keeps the whole tag as the pill', () => {
    expect(findTags('@claude/summarize this note', NAMES)).toEqual([{ name: 'claude', from: 0, to: 17, skill: 'summarize' }]);
    expect(findMention('@claude/summarize this note', NAMES)).toEqual({ name: 'claude', prompt: 'this note', skill: 'summarize' });
    expect(findMention('see @Codex/review-pr: the intro', NAMES)).toEqual({ name: 'codex', prompt: 'the intro', skill: 'review-pr' });
  });

  it('leaves a tag without a slash as before', () => {
    expect(findMention('@claude do this', NAMES)).toEqual({ name: 'claude', prompt: 'do this' });
    expect(findTags('@claude/', NAMES)).toEqual([{ name: 'claude', from: 0, to: 7 }]);
  });
});
