import { spawn } from 'node:child_process';
import { clearTimeout, setTimeout } from 'node:timers';
import { z } from 'zod';
import { askPermission, defineTool, type AgentTool, type PermissionHandler } from './session.ts';
import type { InlineShellApproval } from './adapters/codex/inline-policy.ts';
import { harnessEnvironment } from './environment.ts';

const COMMAND_INPUT = {
  command: z.string().trim().min(1).describe('The complete command to show the user before running.'),
  timeout_seconds: z.number().int().min(1).max(300).default(60),
};

export function inlineCommandTool(cwd: string, onPermission: PermissionHandler, approval: InlineShellApproval = 'ask', env: Record<string, string> = {}): AgentTool {
  return defineTool({
    name: 'run_command',
    description: `Run a command. ${approval === 'yolo' ? 'The user enabled YOLO: commands run without approval prompts.' : 'The user must approve each exact invocation.'} Working directory: ${cwd}. Shell: ${process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'}. Commands may access the network or change files. Output is limited to 64 KiB.`,
    input: COMMAND_INPUT,
    title: ({ command }) => `Run ${command}`,
    run: async (input, { signal }) => {
      const { command, timeout_seconds } = z.object(COMMAND_INPUT).parse(input);
      if (signal.aborted) return { text: 'Command cancelled.', isError: true };
      const decision = approval === 'yolo' ? 'allow' : await askPermission(onPermission, {
        tool: 'inlineCommand', title: `Run ${command}`,
        detail: `Directory: ${cwd}\nTimeout: ${timeout_seconds}s\n\n${command}`,
        raw: { command, cwd, timeout_seconds }, signal,
      });
      if (decision === 'deny' || signal.aborted) return { text: 'Command not run: approval denied or cancelled.', isError: true };
      // Approval is never cached, including an allow-session response from a custom handler.
      const environment = await harnessEnvironment(env);
      if (signal.aborted) return { text: 'Command cancelled.', isError: true };
      return runCommand(command, cwd, timeout_seconds * 1000, signal, environment);
    },
  });
}

function runCommand(command: string, cwd: string, timeout: number, signal: AbortSignal, env: Record<string, string>): Promise<{ text: string; isError: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, env, shell: true, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let stopped: string | undefined;
    const capture = (chunk: Buffer) => {
      const remaining = 65536 - size;
      if (chunk.length > remaining) truncated = true;
      if (remaining > 0) { const part = chunk.subarray(0, remaining); chunks.push(part); size += part.length; }
    };
    const stop = (reason: string) => {
      if (stopped) return;
      stopped = reason;
      if (child.pid && process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    };
    const abort = () => stop('Command cancelled.');
    const timer = setTimeout(() => stop('Command timed out.'), timeout);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    const finish = (code: number | null, error?: string) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      const output = Buffer.concat(chunks).toString('utf8');
      resolve({ text: [output, truncated && '[Output truncated at 64 KiB]', stopped ?? error ?? `Exit code: ${code}`].filter(Boolean).join('\n'), isError: Boolean(stopped || error || code !== 0) });
    };
    child.on('error', (error) => finish(null, error.message));
    child.on('close', (code) => finish(code));
  });
}
