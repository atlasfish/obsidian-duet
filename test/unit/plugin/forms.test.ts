import { describe, expect, it } from 'vitest';
import { agentForm, formName, frontMatter, recognize } from '../../../plugin/src/skills/forms.ts';

describe('recognize', () => {
  const paths = [
    'Writing/Summarize/SKILL.md',
    'Writing/Summarize/examples.md',
    'Agents/Skeptic/AGENT.md',
    'SKILL.md',
    'internal/wiki/skills/ingest/SKILL.md',
    'conversations/Skill chat/SKILL.md',
    'Other/summarize/SKILL.md',
    'Notes/Weekly review.md',
  ];

  it('finds SKILL.md and AGENT.md in named folders and names them by the folder', () => {
    const found = recognize(paths, ['internal', 'conversations']);
    expect(found.skills.map((skill) => skill.name)).toEqual(['summarize']);
    expect(found.skills[0]).toEqual({ name: 'summarize', folder: 'Other/summarize', path: 'Other/summarize/SKILL.md' });
    expect(found.agents).toEqual([{ name: 'skeptic', folder: 'Agents/Skeptic', path: 'Agents/Skeptic/AGENT.md' }]);
  });

  it('skips the root, the excluded folders, and a second file of a name', () => {
    const found = recognize(paths, ['internal', 'conversations']);
    expect(found.problems).toEqual(['Writing/Summarize/SKILL.md: another skill is already named summarize (Other/summarize/SKILL.md).']);
    expect(recognize(['internal/x/SKILL.md'], ['internal']).skills).toEqual([]);
    expect(recognize(['internal/x/SKILL.md'], []).skills).toHaveLength(1);
  });
});

describe('formName', () => {
  it('makes a command name from a folder name', () => {
    expect(formName('Writing/Plan a Night')).toBe('plan-a-night');
    expect(formName('Skills/review_pr')).toBe('review_pr');
    expect(formName('A/ (odd) ')).toBe('odd');
  });
});

describe('agentForm', () => {
  it('reads the description, the prompt, the tools and the model', () => {
    const form = agentForm('---\nname: skeptic\ndescription: "Checks a plan"\ntools: [Read, Grep]\nmodel: haiku\n---\nBe skeptical.\n');
    expect(form).toEqual({ description: 'Checks a plan', prompt: 'Be skeptical.', tools: ['Read', 'Grep'], model: 'haiku' });
  });

  it('limits a read-only agent to reading tools, and reports what is missing', () => {
    expect(agentForm('---\ndescription: x\naccess: read-only\n---\nRead.')).toMatchObject({ tools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'] });
    expect(agentForm('---\nname: x\n---\nRead.')).toEqual({ problem: 'the front matter has no description.' });
    expect(agentForm('---\ndescription: x\n---\n')).toEqual({ problem: 'the file has no prompt after the front matter.' });
  });

  it('reads simple front matter', () => {
    expect(frontMatter('---\nname: a\ndescription: \'b c\'\n---\nbody')).toEqual({ name: 'a', description: 'b c' });
    expect(frontMatter('no front matter')).toEqual({});
  });
});
