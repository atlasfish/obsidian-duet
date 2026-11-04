// The pure part of the vault's skills and agents: which files count, and what their front matter says.

/** A `SKILL.md` or `AGENT.md` of the vault, named by its folder. */
export interface VaultForm {
  name: string;
  /** The folder that holds the file, as a vault path. */
  folder: string;
  /** The file, as a vault path. */
  path: string;
}

export interface Recognized {
  skills: VaultForm[];
  agents: VaultForm[];
  /** What Duet could not use, for the settings. */
  problems: string[];
}

/** A subagent for Claude Code, from an `AGENT.md`. */
export interface AgentForm {
  description: string;
  prompt: string;
  tools?: string[];
  model?: string;
}

/** A skill's or an agent's name from its folder: lower case, with `-` for spaces and other separators. */
export function formName(folder: string): string {
  return (folder.split('/').pop() ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The skills and agents among the vault's files: each `SKILL.md` or `AGENT.md` in a folder below the root,
 * outside the excluded folders. Two files that would share a name keep the first by path, and the other
 * is a problem.
 */
export function recognize(paths: string[], exclude: string[]): Recognized {
  const result: Recognized = { skills: [], agents: [], problems: [] };
  const excluded = exclude.filter(Boolean).map((folder) => `${folder.replace(/\/$/, '')}/`);
  const seen = { skills: new Map<string, VaultForm>(), agents: new Map<string, VaultForm>() };
  for (const path of [...paths].sort()) {
    const match = /^(.+)\/(SKILL|AGENT)\.md$/.exec(path);
    if (!match || excluded.some((folder) => path.startsWith(folder))) continue;
    const kind = match[2] === 'SKILL' ? 'skills' : 'agents';
    const folder = match[1]!;
    const name = formName(folder);
    if (!name) {
      result.problems.push(`${path}: the folder has no usable name.`);
      continue;
    }
    const other = seen[kind].get(name);
    if (other) {
      result.problems.push(`${path}: another ${kind === 'skills' ? 'skill' : 'agent'} is already named ${name} (${other.path}).`);
      continue;
    }
    const form = { name, folder, path };
    seen[kind].set(name, form);
    result[kind].push(form);
  }
  return result;
}

/** The front matter of a Markdown file, one value for each key. A list in brackets or separated by commas is kept as text. */
export function frontMatter(text: string): Record<string, string> {
  const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
  const values: Record<string, string> = {};
  if (!block) return values;
  for (const line of block.split(/\r?\n/)) {
    const match = /^([\w-]+):\s*(.*)$/.exec(line);
    if (match) values[match[1]!] = match[2]!.trim().replace(/^(["'])([\s\S]*)\1$/, '$2');
  }
  return values;
}

/** The text of a Markdown file without its front matter. */
export function body(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trim();
}

/** The `description` of a form's front matter, or an empty string. */
export function description(text: string): string {
  return frontMatter(text).description ?? '';
}

/** A list of the front matter: `[a, b]`, `a, b`, or one word. */
function list(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((item) => item.trim().replace(/^(["'])(.*)\1$/, '$2'))
    .filter(Boolean);
  return items.length ? items : undefined;
}

/**
 * A subagent from an `AGENT.md`: the description and the prompt are required. `tools` and `model` are
 * passed on; `access: read-only` limits the tools to reading when `tools` is not set.
 */
export function agentForm(text: string): AgentForm | { problem: string } {
  const front = frontMatter(text);
  const prompt = body(text);
  if (!front.description) return { problem: 'the front matter has no description.' };
  if (!prompt) return { problem: 'the file has no prompt after the front matter.' };
  const tools = list(front.tools) ?? (front.access === 'read-only' ? ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'] : undefined);
  return { description: front.description, prompt, ...(tools && { tools }), ...(front.model && { model: front.model }) };
}
