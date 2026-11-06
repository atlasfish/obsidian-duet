import { Prec } from '@codemirror/state';
import { type EditorView, keymap } from '@codemirror/view';
import { editorInfoField, type TFile } from 'obsidian';
import { calloutHeader, isCalloutHeader } from './callout.ts';
import { findMention, type Mention } from './mention.ts';
import { inCode } from './mention-tags.ts';

export interface TriggeredMention extends Mention {
  file: TFile;
  view: EditorView;
  /** Zero-based line number of the tagged line. */
  line: number;
  /** Position of the tagged line's start, and of the reply callout's header line. */
  lineFrom: number;
  callout: { from: number; to: number };
}

/**
 * Enter at the end of a line with `@name request` inserts a reply callout under the line,
 * moves the cursor below it, and reports the mention. Any other Enter behaves as usual.
 */
export function enterTrigger(
  names: () => string[],
  title: (name: string) => string,
  onMention: (mention: TriggeredMention) => void,
) {
  return Prec.high(
    keymap.of([
      {
        key: 'Enter',
        run: (view) => {
          const mention = mentionAtCursor(view, names());
          if (!mention) return false;
          const { line, file } = mention;
          const header = calloutHeader(title(mention.name));
          const insert = `\n${header}\n\n`;
          view.dispatch({
            changes: { from: line.to, insert },
            selection: { anchor: line.to + insert.length },
            scrollIntoView: true,
            userEvent: 'input',
          });
          const from = line.to + 1;
          onMention({
            name: mention.name,
            prompt: mention.prompt,
            ...(mention.skill && { skill: mention.skill }),
            file,
            view,
            line: line.number - 1,
            lineFrom: line.from,
            callout: { from, to: from + header.length },
          });
          return true;
        },
      },
    ]),
  );
}

function mentionAtCursor(view: EditorView, names: string[]) {
  const { state } = view;
  const selection = state.selection;
  if (selection.ranges.length !== 1 || !selection.main.empty) return undefined;
  const line = state.doc.lineAt(selection.main.head);
  if (selection.main.head !== line.to) return undefined;
  const mention = findMention(line.text, names);
  if (!mention || inCode(state, line.from + Math.max(line.text.indexOf('@'), 0))) return undefined;
  if (line.number < state.doc.lines && isCalloutHeader(state.doc.line(line.number + 1).text)) return undefined;
  const file = state.field(editorInfoField, false)?.file;
  if (!file) return undefined;
  return { ...mention, line, file };
}
