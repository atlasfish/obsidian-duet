import { type ClaudeSessionOptions, startClaudeSession } from './adapters/claude.ts';
import { type CodexSessionOptions, startCodexSession } from './adapters/codex/session.ts';
import type { AgentSession } from './session.ts';

export type CreateSessionOptions =
  | ({ harness: 'claude' } & ClaudeSessionOptions)
  | ({ harness: 'codex' } & CodexSessionOptions);

/** Starts a harness process and resolves when the session is ready for `send`. */
export function createSession(options: CreateSessionOptions): Promise<AgentSession> {
  return options.harness === 'claude' ? startClaudeSession(options) : startCodexSession(options);
}

export type { ClaudeSessionOptions, CodexSessionOptions };
export type { InlineToolPolicy, InlineShellApproval } from './adapters/codex/inline-policy.ts';
export { inlineCommandTool } from './inline-command.ts';
export { type ApprovalSetting, approvalOptions } from './approval.ts';
export { findExecutable, harnessEnvironment } from './environment.ts';
export * from './session.ts';
