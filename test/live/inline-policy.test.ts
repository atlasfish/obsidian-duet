import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { startCodexSession, type CodexSessionOptions } from '../../src/adapters/codex/session.ts';
import { inlineCommandTool } from '../../src/inline-command.ts';

// Runs a real CLI against local HTTP/MCP fixtures. Never uses the user's model service or login.
const binary = process.env.DUET_CODEX_BINARY;
const fixture = fileURLToPath(new URL('../fixtures/inline-mcp.mjs', import.meta.url));

describe.skipIf(!binary)('real Codex inline tool policy', () => {
  it('exposes only the selected MCP tool and web search, without native Shell', async () => {
    const home = await mkdtemp(join(tmpdir(), 'duet-codex-policy-'));
    let captured: { tools: unknown[]; input: unknown[] } | undefined;
    let requestCommand = true;
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        if (!req.url?.endsWith('/responses')) { res.writeHead(404); res.end(); return; }
        captured = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof captured;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const send = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
        if (requestCommand) {
          requestCommand = false;
          const call = { id: 'fc-1', type: 'function_call', namespace: 'duet', name: 'run_command', call_id: 'call-1', arguments: JSON.stringify({ command: 'echo duet-smoke' }) };
          send({ type: 'response.created', response: { id: 'resp-tool' } });
          send({ type: 'response.output_item.added', output_index: 0, item: { ...call, arguments: '' } });
          send({ type: 'response.output_item.done', output_index: 0, item: call });
          send({ type: 'response.completed', response: { id: 'resp-tool', status: 'completed', output: [call], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
          res.end();
          return;
        }
        const message = { id: 'msg-1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok', annotations: [] }] };
        send({ type: 'response.created', response: { id: 'resp-1' } });
        send({ type: 'response.output_item.added', output_index: 0, item: { ...message, content: [] } });
        send({ type: 'response.output_text.delta', item_id: 'msg-1', output_index: 0, content_index: 0, delta: 'ok' });
        send({ type: 'response.output_item.done', output_index: 0, item: message });
        send({ type: 'response.completed', response: { id: 'resp-1', status: 'completed', output: [message], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const quote = (value: string) => JSON.stringify(value.replaceAll('\\', '/'));
    await writeFile(join(home, 'config.toml'), `model = "gpt-inline-smoke"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "fixture"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\n[mcp_servers.logs]\ncommand = ${quote(process.execPath)}\nargs = [${quote(fixture)}]\n[mcp_servers.mail]\ncommand = ${quote(process.execPath)}\nargs = [${quote(fixture)}]\n`);
    let session: Awaited<ReturnType<typeof startCodexSession>> | undefined;
    try {
      const options = { cwd: home, clientName: 'duet-policy-smoke', executablePath: binary,
        env: { CODEX_HOME: home }, access: 'read-only',
        tools: { name: 'duet', description: 'Duet tools', tools: [inlineCommandTool(home, async () => { throw new Error('YOLO must not ask'); }, 'yolo')] },
        inlineTools: { webSearch: true, shell: true, shellApproval: 'yolo', mcpTools: { logs: ['read_logs'] } } } satisfies CodexSessionOptions;
      session = await startCodexSession(options);
      const result = await session.send('Say ok.');
      expect(result.status, JSON.stringify(result)).toBe('completed');
      const tools = JSON.stringify(captured?.tools);
      expect(tools).toContain('web_search');
      expect(tools).toContain('run_command');
      expect(tools).toContain('read_logs');
      expect(tools).not.toContain('delete_logs');
      expect(tools).not.toContain('mcp__mail');
      expect(tools).not.toContain('exec_command');
      expect(tools).not.toContain('shell_command');
      expect(tools).not.toContain('apply_patch');
      expect(JSON.stringify(captured?.input)).toContain('duet-smoke');
      expect(JSON.stringify(captured?.input)).toContain('Exit code: 0');
      const resume = session.id;
      await session.close();
      session = await startCodexSession({ ...options, resume });
      requestCommand = true;
      expect((await session.send('Say ok again.')).status).toBe('completed');
      expect(JSON.stringify(captured?.tools)).toContain('run_command');
      expect(JSON.stringify(captured?.tools)).not.toContain('delete_logs');
      expect(JSON.stringify(captured?.input)).toContain('Exit code: 0');
    } catch (error) {
      console.error('Captured model tools:', JSON.stringify(captured?.tools));
      throw error;
    } finally {
      await session?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 60000);
});
