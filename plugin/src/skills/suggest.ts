import { type App, type Editor, type EditorPosition, EditorSuggest, type EditorSuggestContext, type EditorSuggestTriggerInfo, type TFile } from 'obsidian';
import type { AgentProfile } from '../settings.ts';
import type { SkillItem, VaultSkills } from './vault-skills.ts';

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Suggests the skills and agents while the person types `@claude/` in a note. */
export class SkillSuggest extends EditorSuggest<SkillItem> {
  private profile: AgentProfile | undefined;

  constructor(
    app: App,
    private readonly skills: VaultSkills,
    private readonly profiles: () => AgentProfile[],
  ) {
    super(app);
  }

  onTrigger(cursor: EditorPosition, editor: Editor, _file: TFile | null): EditorSuggestTriggerInfo | null {
    const profiles = this.profiles();
    if (!profiles.length) return null;
    const before = editor.getLine(cursor.line).slice(0, cursor.ch);
    const pattern = new RegExp(`(?:^|[\\s([{])@(${profiles.map((profile) => escape(profile.name)).join('|')})/([\\w.-]*)$`, 'i');
    const match = pattern.exec(before);
    if (!match) return null;
    this.profile = profiles.find((profile) => profile.name.toLowerCase() === match[1]!.toLowerCase());
    if (!this.profile || !this.skills.items(this.profile).length) return null;
    const query = match[2]!;
    return { start: { line: cursor.line, ch: cursor.ch - query.length }, end: cursor, query };
  }

  getSuggestions(context: EditorSuggestContext): SkillItem[] {
    if (!this.profile) return [];
    const query = context.query.toLowerCase();
    return this.skills.items(this.profile).filter((item) => item.name.toLowerCase().includes(query) || item.description.toLowerCase().includes(query));
  }

  renderSuggestion(item: SkillItem, el: HTMLElement): void {
    el.addClass('duet-skill-suggestion');
    const title = el.createDiv({ cls: 'duet-skill-title' });
    title.createSpan({ text: item.name });
    title.createSpan({ cls: 'duet-skill-kind', text: item.kind === 'agent' ? 'agent' : 'skill' });
    if (item.source === 'installed') title.createSpan({ cls: 'duet-skill-kind', text: 'installed' });
    if (item.description) el.createDiv({ cls: 'duet-skill-description', text: item.description });
  }

  selectSuggestion(item: SkillItem): void {
    const { context } = this;
    if (!context) return;
    context.editor.replaceRange(`${item.name} `, context.start, context.end);
    const cursor = { line: context.start.line, ch: context.start.ch + item.name.length + 1 };
    context.editor.setCursor(cursor);
  }
}
