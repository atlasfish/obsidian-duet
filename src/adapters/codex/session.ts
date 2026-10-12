import { type ChildProcess, spawn } from 'node:child_process';
import { clearTimeout, setTimeout } from 'node:timers';
import { z } from 'zod';
import { findExecutable, harnessEnvironment, pathDisplay } from '../../environment.ts';
import {
  type AgentTool,
  askPermission,
  BaseSession,
  type CommandOption,
  type ModelOption,
  type PermissionDecision,
  runTool,
  type SessionOptions,
  type SessionSettings,
} from '../../session.ts';
import { codexApprovalPolicy } from '../../approval.ts';
import type {
  AgentMessageDelta,
  ApprovalDecision,
  ApprovalPolicy,
  CommandApprovalParams,
  DynamicToolCallParams,
  ErrorNotification,
  FileChangeApprovalParams,
  ItemNotification,
  Model,
  PermissionsApprovalParams,
  ReasoningDelta,
  SandboxMode,
  Skill,
  ThreadItem,
  ThreadStartResponse,
  TurnNotification,
} from './protocol.ts';
import { RpcConnection, RpcError } from './rpc.ts';
import { inlineConfig, type CodexToolConfig, type InlineToolPolicy } from './inline-policy.ts';

export interface CodexSessionOptions extends SessionOptions {
  /** Enforce the optional tools selected for a mention. Native commands remain disabled. */
  inlineTools?: InlineToolPolicy;
  /** When Codex asks before it acts. Default: `on-request`. */
  approvalPolicy?: ApprovalPolicy;
  /** What commands can do without approval. Default: `workspace-write`. */
  sandbox?: SandboxMode;
}

const CLIENT_VERSION = '0.1.0';
const STDERR_LIMIT = 4096;
const CLOSE_GRACE_MS = 2000;

const DECISIONS: Record<PermissionDecision, ApprovalDecision> = {
  allow: 'accept',
  'allow-session': 'acceptForSession',
  deny: 'decline',
};

export async function startCodexSession(options: CodexSessionOptions): Promise<CodexSession> {
  const env = await harnessEnvironment(options.env);
  const executable = options.executablePath ?? (await findExecutable('codex', env));
  const child = spawn(executable, ['app-server'], {
    cwd: options.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const session = new CodexSession(child, options);
  try {
    await session.start();
  } catch (error) {
    await session.close();
    throw error;
  }
  return session;
}

export class CodexSession extends BaseSession {
  readonly harness = 'codex';
  private threadId = '';
  private readonly rpc: RpcConnection;
  private turnId: string | undefined;
  /** The server accepts `turn/interrupt` only after it sends `turn/started`. */
  private turnStarted = false;
  private finalMessage = '';
  private lastError: string | undefined;
  private readonly items = new Map<string, ThreadItem>();
  private readonly appTools = new Map<string, AgentTool>();
  private settings: SessionSettings = {};
  private skills: Promise<Skill[]> | undefined;
  private stderr = '';
  private readonly exited: Promise<void>;
  private readonly showPath: (file: string) => string;

  constructor(
    private readonly child: ChildProcess,
    private readonly options: CodexSessionOptions,
  ) {
    super();
    this.showPath = pathDisplay(options.cwd);
    for (const appTool of options.tools?.tools ?? []) this.appTools.set(appTool.name, appTool);
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_LIMIT);
    });
    this.exited = new Promise((resolve) => {
      child.on('error', (error) => {
        this.shutdown(`Could not start codex: ${error.message}`);
        resolve();
      });
      child.on('exit', (code, signal) => {
        this.shutdown(this.exitMessage(code, signal));
        resolve();
      });
    });
    this.rpc = new RpcConnection(child.stdout!, child.stdin!, {
      onNotification: (method, params) => this.handleNotification(method, params),
      onRequest: (method, params) => this.handleRequest(method, params),
    });
  }

  get id(): string {
    return this.threadId;
  }

  async start(): Promise<void> {
    const name = this.options.clientName;
    const { tools } = this.options;
    await this.rpc.request('initialize', {
      clientInfo: { name, title: name, version: CLIENT_VERSION },
      // Dynamic tools are part of the experimental API.
      capabilities: tools ? { experimentalApi: true, requestAttestation: false } : null,
    });
    this.rpc.notify('initialized');
    const inlineTools = this.options.inlineTools;
    const config = inlineTools
      ? inlineConfig(inlineTools, (await this.rpc.request<{ config: CodexToolConfig }>('config/read', { includeLayers: false, cwd: this.options.cwd })).config)
      : undefined;
    const readOnly = this.options.access === 'read-only';
    const settings = {
      cwd: this.options.cwd,
      model: this.options.model ?? null,
      approvalPolicy: readOnly ? 'never' : (this.options.approvalPolicy ?? 'on-request'),
      sandbox: readOnly ? 'read-only' : (this.options.sandbox ?? 'workspace-write'),
      developerInstructions: this.options.instructions ?? null,
      ...(config && { config }),
    };
    const dynamicTools = tools && [
      {
        type: 'namespace',
        name: tools.name,
        description: tools.description,
        tools: tools.tools.map((appTool) => ({
          type: 'function',
          name: appTool.name,
          description: appTool.description,
          inputSchema: z.toJSONSchema(z.object(appTool.input)),
        })),
      },
    ];
    const response = this.options.resume
      ? await this.rpc.request<ThreadStartResponse>('thread/resume', {
          threadId: this.options.resume,
          excludeTurns: true,
          ...settings,
        })
      : await this.rpc.request<ThreadStartResponse>('thread/start', { ...settings, ...(dynamicTools && { dynamicTools }) });
    this.threadId = response.thread.id;
    if (this.options.effort) this.settings.effort = this.options.effort;
  }

  async models(): Promise<ModelOption[]> {
    const { data } = await this.rpc.request<{ data: Model[] }>('model/list', {});
    return data
      .filter((model) => !model.hidden)
      .map((model) => ({
        id: model.model,
        name: model.displayName,
        description: model.description,
        efforts: model.supportedReasoningEfforts.map((option) => option.reasoningEffort),
        defaultEffort: model.defaultReasoningEffort,
        isDefault: model.isDefault,
      }));
  }

  /** Codex skills. `send('/name request')` invokes the skill `name`. */
  async commands(): Promise<CommandOption[]> {
    const skills = await this.loadSkills();
    return skills.map((skill) => ({ name: skill.name, description: skill.shortDescription ?? skill.description }));
  }

  async configure(settings: SessionSettings): Promise<void> {
    this.settings = { ...this.settings, ...settings };
  }

  private loadSkills(): Promise<Skill[]> {
    this.skills ??= this.rpc
      .request<{ data: { skills: Skill[] }[] }>('skills/list', { cwds: [this.options.cwd] })
      .then(({ data }) => data.flatMap((entry) => entry.skills).filter((skill) => skill.enabled))
      .catch(() => []);
    return this.skills;
  }

  private async input(text: string): Promise<unknown[]> {
    const message = { type: 'text', text, text_elements: [] };
    const command = text.match(/^\/([\w:-]+)\s*([\s\S]*)$/);
    if (!command) return [message];
    const skill = (await this.loadSkills()).find((candidate) => candidate.name === command[1]);
    if (!skill) return [message];
    return [{ type: 'skill', name: skill.name, path: skill.path }, { ...message, text: command[2] || `Use the ${skill.name} skill.` }];
  }

  protected async startTurn(text: string): Promise<void> {
    this.turnId = undefined;
    this.turnStarted = false;
    this.finalMessage = '';
    this.lastError = undefined;
    this.items.clear();
    const { model, effort, approval } = this.settings;
    const response = await this.rpc.request<{ turn: { id: string } }>('turn/start', {
      threadId: this.threadId,
      input: await this.input(text),
      ...(model !== undefined && { model }),
      ...(effort !== undefined && { effort }),
      ...(approval && this.options.access !== 'read-only' && { approvalPolicy: codexApprovalPolicy(approval) }),
    });
    this.turnId ??= response.turn.id;
  }

  protected async interruptTurn(): Promise<void> {
    if (this.turnStarted) await this.requestInterrupt();
  }

  async close(): Promise<void> {
    this.shutdown();
    this.child.stdin?.end();
    const timer = setTimeout(() => this.child.kill(), CLOSE_GRACE_MS);
    await this.exited;
    clearTimeout(timer);
  }

  private async requestInterrupt(): Promise<void> {
    try {
      await this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId });
    } catch {
      // The turn already ended.
    }
  }

  private shutdown(error?: string): void {
    this.rpc.close(new Error(error ?? 'Session closed'));
    this.markClosed(error);
  }

  private exitMessage(code: number | null, signal: NodeJS.Signals | null): string | undefined {
    if (code === 0 || (this.closed && signal)) return undefined;
    const reason = signal ? `signal ${signal}` : `code ${code}`;
    const detail = this.stderr.trim().split('\n').slice(-5).join('\n');
    return `codex app-server exited with ${reason}${detail ? `:\n${detail}` : ''}`;
  }

  private handleNotification(method: string, params: unknown): void {
    if ((params as { threadId?: string } | undefined)?.threadId !== this.threadId || !this.currentTurn) return;
    switch (method) {
      case 'item/agentMessage/delta':
        this.emit({ type: 'text-delta', text: (params as AgentMessageDelta).delta });
        break;
      case 'item/reasoning/summaryTextDelta':
        this.emit({ type: 'thinking-delta', text: (params as ReasoningDelta).delta });
        break;
      case 'item/reasoning/summaryPartAdded':
        if ((params as ReasoningDelta).summaryIndex > 0) this.emit({ type: 'thinking-delta', text: '\n\n' });
        break;
      case 'item/started':
        this.itemStarted((params as ItemNotification).item);
        break;
      case 'item/completed':
        this.itemCompleted((params as ItemNotification).item);
        break;
      case 'error': {
        const { error, willRetry } = params as ErrorNotification;
        if (!willRetry) this.lastError = error.message;
        break;
      }
      case 'turn/started':
        this.turnId ??= (params as TurnNotification).turn.id;
        this.turnStarted = true;
        if (this.currentTurn.interruptRequested) void this.requestInterrupt();
        break;
      case 'turn/completed':
        this.turnCompleted(params as TurnNotification);
        break;
    }
  }

  private itemStarted(item: ThreadItem): void {
    this.items.set(item.id, item);
    // Without an approval request, Codex applies the change without waiting for this call.
    if (item.type === 'fileChange' && 'changes' in item) void this.beforeFileChange(item.changes.map((change) => this.showPath(change.path)));
    const title = this.describeItem(item);
    if (!title) return;
    const tool = item.type === 'dynamicToolCall' && 'tool' in item ? `${item.namespace}.${item.tool}` : item.type;
    this.emit({ type: 'tool-start', id: item.id, tool, title, ...this.itemDetail(item) });
  }

  private async beforeFileChange(paths: string[]): Promise<void> {
    if (!paths.length) return;
    try {
      await this.options.beforeFileChange?.(paths);
    } catch {
      // The change goes ahead.
    }
  }

  private itemDetail(item: ThreadItem): { detail?: string; paths?: string[] } {
    if (item.type === 'commandExecution' && 'command' in item) return { detail: unwrapShell(item.command) };
    if (item.type === 'fileChange' && 'changes' in item) {
      return {
        detail: item.changes.map((change) => change.diff).join('\n'),
        paths: item.changes.map((change) => this.showPath(change.path)),
      };
    }
    return {};
  }

  private itemCompleted(item: ThreadItem): void {
    this.items.set(item.id, item);
    if (item.type === 'agentMessage' && 'text' in item) {
      this.finalMessage = item.text;
      this.emit({ type: 'message', text: item.text });
      return;
    }
    if (item.type === 'reasoning' && 'summary' in item) {
      const text = item.summary.join('\n\n').trim();
      if (text) this.emit({ type: 'thinking', text });
      return;
    }
    if (!this.describeItem(item)) return;
    const status = 'status' in item ? item.status : 'completed';
    let ok = status === 'completed';
    let output: string | undefined;
    if (item.type === 'commandExecution' && 'command' in item) {
      ok &&= item.exitCode === 0;
      output = item.aggregatedOutput ?? undefined;
    } else if (item.type === 'mcpToolCall' && 'error' in item) {
      output = item.error?.message;
    } else if (item.type === 'dynamicToolCall' && 'contentItems' in item) {
      ok = item.success ?? ok;
      output = item.contentItems?.map((content) => content.text ?? '').join('');
    }
    this.emit({ type: 'tool-end', id: item.id, ok, output });
  }

  private turnCompleted({ turn }: TurnNotification): void {
    if (this.turnId && turn.id !== this.turnId) return;
    const status = turn.status === 'inProgress' ? 'failed' : turn.status;
    const error = turn.error?.message ?? (status === 'failed' ? this.lastError : undefined);
    this.currentTurn?.finish({ status, text: this.finalMessage, ...(error && { error }) });
  }

  private async handleRequest(method: string, params: unknown): Promise<unknown> {
    const signal = this.currentTurn?.controller.signal ?? AbortSignal.abort();
    const ask = (tool: string, title: string, detail?: string) =>
      askPermission(this.options.onPermission, { tool, title, detail, raw: params, signal });

    switch (method) {
      case 'item/commandExecution/requestApproval': {
        if (this.options.inlineTools) return { decision: 'decline' };
        const request = params as CommandApprovalParams;
        const detail = [request.command, request.reason && `Reason: ${request.reason}`]
          .filter(Boolean)
          .join('\n');
        const title = request.command ? `Run ${unwrapShell(request.command)}` : 'Run a command';
        const decision = await ask('command', title, detail);
        return { decision: DECISIONS[decision] };
      }
      case 'item/fileChange/requestApproval': {
        if (this.options.inlineTools) return { decision: 'decline' };
        const request = params as FileChangeApprovalParams;
        const item = this.items.get(request.itemId);
        const changes = item && 'changes' in item ? item.changes : [];
        const paths = changes.map((change) => this.showPath(change.path));
        const detail = [request.reason, ...changes.map((change) => change.diff)].filter(Boolean).join('\n');
        await this.beforeFileChange(paths);
        const decision = await ask('fileChange', `Edit ${paths.join(', ') || 'files'}`, detail);
        return { decision: DECISIONS[decision] };
      }
      case 'item/permissions/requestApproval': {
        if (this.options.inlineTools) return { permissions: {}, scope: 'turn' };
        const request = params as PermissionsApprovalParams;
        const detail = [request.reason, JSON.stringify(request.permissions, null, 2)].filter(Boolean).join('\n');
        const decision = await ask('permissions', 'Grant extra permissions', detail);
        if (decision === 'deny') return { permissions: {}, scope: 'turn' };
        const { network, fileSystem } = request.permissions;
        return {
          permissions: { ...(network && { network }), ...(fileSystem && { fileSystem }) },
          scope: decision === 'allow-session' ? 'session' : 'turn',
        };
      }
      case 'item/tool/call': {
        const call = params as DynamicToolCallParams;
        const appTool = call.namespace === this.options.tools?.name ? this.appTools.get(call.tool) : undefined;
        const { text, isError } = appTool
          ? await runTool(appTool, call.arguments, signal)
          : { text: `Unknown tool ${call.namespace}.${call.tool}`, isError: true };
        return { contentItems: [{ type: 'inputText', text }], success: !isError };
      }
      case 'mcpServer/elicitation/request':
        return { action: 'decline', content: null, _meta: null };
      default:
        throw new RpcError(-32601, `obsidian-duet does not support ${method}`);
    }
  }

  private describeItem(item: ThreadItem): string | undefined {
    switch (item.type) {
      case 'commandExecution':
        return 'command' in item ? unwrapShell(item.command) : 'command';
      case 'fileChange':
        return 'changes' in item
          ? `Edit ${item.changes.map((change) => this.showPath(change.path)).join(', ')}`
          : 'Edit files';
      case 'mcpToolCall':
        return 'server' in item ? `${item.server}.${item.tool}` : 'MCP tool';
      case 'webSearch':
        return 'query' in item && item.query ? `Search: ${item.query}` : 'Web search';
      case 'dynamicToolCall': {
        if (!('tool' in item)) return 'Tool';
        const appTool = item.namespace === this.options.tools?.name ? this.appTools.get(item.tool) : undefined;
        return appTool?.title?.(item.arguments as never) ?? item.tool;
      }
      default:
        return undefined;
    }
  }
}

/** Codex runs commands as `/bin/zsh -lc '<command>'`. Titles show the inner command. */
export function unwrapShell(command: string): string {
  const match = command.match(/^\S*\/(?:ba|z)?sh -l?c (['"])([\s\S]*)\1$/);
  return match?.[2] ?? command;
}
