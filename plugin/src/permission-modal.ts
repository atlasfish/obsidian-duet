import { type App, Modal } from 'obsidian';
import type { PermissionDecision, PermissionRequest, QuestionAnswers, QuestionRequest } from '../../src/index.ts';
import { renderQuestions } from './question-form.ts';

export interface PermissionContext {
  agent: string;
  notePath: string;
}

const FILE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'fileChange']);

function action(tool: string): string {
  if (tool === 'Bash' || tool === 'command' || tool === 'inlineCommand') return 'run a command';
  if (FILE_TOOLS.has(tool)) return 'change a file';
  if (tool === 'permissions') return 'get more access';
  return `use ${tool}`;
}

/** Shows approval requests and questions one at a time. Requests from several notes wait in order. */
export class PermissionPrompts {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly app: App) {}

  ask(request: PermissionRequest, context: PermissionContext): Promise<PermissionDecision> {
    return this.enqueue(request.signal, 'deny', () => new PermissionModal(this.app, request, context).result);
  }

  question(request: QuestionRequest, context: PermissionContext): Promise<QuestionAnswers | undefined> {
    return this.enqueue(request.signal, undefined, () => new QuestionModal(this.app, request, context).result);
  }

  private enqueue<T>(signal: AbortSignal, fallback: T, open: () => Promise<T>): Promise<T> {
    const answer = this.queue.then(() => (signal.aborted ? fallback : open()));
    this.queue = answer.catch(() => undefined);
    return answer;
  }
}

class QuestionModal extends Modal {
  readonly result: Promise<QuestionAnswers | undefined>;
  private resolve!: (answers: QuestionAnswers | undefined) => void;
  private decided = false;

  constructor(
    app: App,
    private readonly request: QuestionRequest,
    private readonly context: PermissionContext,
  ) {
    super(app);
    this.result = new Promise((resolve) => {
      this.resolve = resolve;
    });
    request.signal.addEventListener('abort', () => this.decide(undefined));
    this.open();
  }

  onOpen(): void {
    this.modalEl.addClass('duet-permission', 'duet-question-modal');
    this.titleEl.setText(`${this.context.agent} asks you`);
    this.contentEl.createEl('p', { cls: 'duet-permission-note', text: `From ${this.context.notePath}` });
    renderQuestions(this.contentEl, this.request.questions, 'duet-permission-choices', (answers) => this.decide(answers)).focus();
  }

  onClose(): void {
    this.contentEl.empty();
    this.decide(undefined);
  }

  private decide(answers: QuestionAnswers | undefined): void {
    if (this.decided) return;
    this.decided = true;
    this.resolve(answers);
    this.close();
  }
}

class PermissionModal extends Modal {
  readonly result: Promise<PermissionDecision>;
  private resolve!: (decision: PermissionDecision) => void;
  private decided = false;

  constructor(
    app: App,
    private readonly request: PermissionRequest,
    private readonly context: PermissionContext,
  ) {
    super(app);
    this.result = new Promise((resolve) => {
      this.resolve = resolve;
    });
    request.signal.addEventListener('abort', () => this.decide('deny'));
    this.open();
  }

  onOpen(): void {
    const { request, context } = this;
    this.modalEl.addClass('duet-permission');
    this.titleEl.setText(`${context.agent} wants to ${action(request.tool)}`);
    const { contentEl } = this;
    contentEl.createEl('p', { cls: 'duet-permission-note', text: `From ${context.notePath}` });
    contentEl.createEl('p', { cls: 'duet-permission-title', text: request.title });

    if (request.detail && !request.title.includes(request.detail)) {
      const pre = contentEl.createEl('pre', { cls: 'duet-permission-detail' });
      const isDiff = FILE_TOOLS.has(request.tool);
      for (const line of request.detail.split('\n')) {
        const kind = !isDiff ? '' : line.startsWith('+') ? 'is-add' : line.startsWith('-') ? 'is-remove' : line.startsWith('@@') ? 'is-hunk' : '';
        pre.createSpan({ cls: `duet-line ${kind}`, text: line || ' ' });
      }
    }

    const choices = contentEl.createDiv({ cls: 'duet-permission-choices' });
    const choice = (label: string, key: string, decision: PermissionDecision, primary = false) => {
      const button = choices.createEl('button', { cls: primary ? 'mod-cta' : '' });
      button.createSpan({ text: label });
      button.createEl('kbd', { text: key.toUpperCase() });
      button.addEventListener('click', () => this.decide(decision));
      this.scope.register([], key, () => {
        this.decide(decision);
        return false;
      });
      return button;
    };
    choice('Allow once', 'y', 'allow', true).focus();
    if (request.tool !== 'inlineCommand') choice('Allow for this conversation', 'a', 'allow-session');
    choice('Deny', 'n', 'deny');
  }

  onClose(): void {
    this.contentEl.empty();
    this.decide('deny');
  }

  private decide(decision: PermissionDecision): void {
    if (this.decided) return;
    this.decided = true;
    this.resolve(decision);
    this.close();
  }
}
