#!/usr/bin/env node
// Imitates `codex app-server` for adapter tests. The prompt text selects the scenario.
import { createInterface } from 'node:readline';

const THREAD = 'thread-1';
let nextId = 1000;
let turnCount = 0;
let activeTurn;
let instructions = null;
let setup = {};
let lastTurn = {};
const waiting = new Map();

const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const notify = (method, params) => send({ method, params: { threadId: THREAD, ...params } });
const request = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    send({ id, method, params: { threadId: THREAD, turnId: activeTurn, ...params } });
  });

function reply(text) {
  const item = { type: 'agentMessage', id: `msg-${turnCount}`, text: '', phase: 'final_answer' };
  notify('item/started', { turnId: activeTurn, item });
  for (const delta of text.match(/.{1,4}/gs) ?? []) {
    notify('item/agentMessage/delta', { turnId: activeTurn, itemId: item.id, delta });
  }
  notify('item/completed', { turnId: activeTurn, item: { ...item, text } });
}

function complete(status = 'completed', error = null) {
  notify('turn/completed', { turn: { id: activeTurn, items: [], status, error } });
  activeTurn = undefined;
}

async function runTurn(prompt) {
  switch (prompt) {
    case 'hello':
      reply('Hello there');
      return complete();
    case 'command': {
      const item = { type: 'commandExecution', id: 'cmd-1', command: 'touch x', cwd: '/', status: 'inProgress' };
      notify('item/started', { turnId: activeTurn, item });
      const response = await request('item/commandExecution/requestApproval', { itemId: item.id, command: 'touch x' });
      notify('item/completed', {
        turnId: activeTurn,
        item: { ...item, status: 'completed', exitCode: 0, aggregatedOutput: 'done' },
      });
      reply(JSON.stringify(response.result));
      return complete();
    }
    case 'file': {
      const changes = [{ path: 'a.md', kind: 'update', diff: '-old\n+new' }];
      notify('item/started', { turnId: activeTurn, item: { type: 'fileChange', id: 'fc-1', changes, status: 'inProgress' } });
      const response = await request('item/fileChange/requestApproval', { itemId: 'fc-1' });
      reply(JSON.stringify(response.result));
      return complete();
    }
    case 'permissions': {
      const permissions = { network: { enabled: true }, fileSystem: null };
      const response = await request('item/permissions/requestApproval', { itemId: 'p-1', cwd: '/', reason: 'needs network', permissions });
      reply(JSON.stringify(response.result));
      return complete();
    }
    case 'unsupported': {
      const response = await request('item/tool/requestUserInput', { itemId: 'q-1', questions: [] });
      reply(JSON.stringify(response.error));
      return complete();
    }
    case 'fail':
      notify('error', { turnId: activeTurn, willRetry: false, error: { message: 'model overloaded' } });
      return complete('failed', null);
    case 'instructions':
      reply(String(instructions));
      return complete();
    case 'setup':
      reply(JSON.stringify(setup));
      return complete();
    case 'turn-settings':
      reply(JSON.stringify({ model: lastTurn.model, effort: lastTurn.effort }));
      return complete();
    case 'tool': {
      const item = { type: 'dynamicToolCall', id: 'dt-1', namespace: 'note', tool: 'append', arguments: { text: 'hi' }, status: 'inProgress', contentItems: null, success: null };
      notify('item/started', { turnId: activeTurn, item });
      const response = await request('item/tool/call', { callId: 'dt-1', namespace: 'note', tool: 'append', arguments: { text: 'hi' } });
      notify('item/completed', { turnId: activeTurn, item: { ...item, status: 'completed', ...response.result } });
      reply(JSON.stringify(response.result));
      return complete();
    }
    case 'reasoning': {
      const item = { type: 'reasoning', id: 'r-1', summary: [], content: [] };
      notify('item/started', { turnId: activeTurn, item });
      notify('item/reasoning/summaryPartAdded', { turnId: activeTurn, itemId: 'r-1', summaryIndex: 0 });
      notify('item/reasoning/summaryTextDelta', { turnId: activeTurn, itemId: 'r-1', delta: 'Plan the reply', summaryIndex: 0 });
      notify('item/reasoning/summaryPartAdded', { turnId: activeTurn, itemId: 'r-1', summaryIndex: 1 });
      notify('item/reasoning/summaryTextDelta', { turnId: activeTurn, itemId: 'r-1', delta: 'Check the note', summaryIndex: 1 });
      notify('item/completed', { turnId: activeTurn, item: { ...item, summary: ['Plan the reply', 'Check the note'] } });
      reply('ok');
      return complete();
    }
    case 'wait':
      return; // Ends on turn/interrupt.
    case 'crash':
      process.stderr.write('fatal: something broke\n');
      process.exit(3);
    default:
      if (prompt.startsWith('Ideas.md')) {
        reply(JSON.stringify(lastTurn.input));
        return complete();
      }
      reply(`echo: ${prompt}`);
      return complete();
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined) {
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
    return;
  }
  const { id, method, params } = message;
  switch (method) {
    case 'initialize':
      setup.capabilities = params.capabilities;
      return send({ id, result: { userAgent: `fake/${params.clientInfo.name}`, codexHome: '/tmp', platformFamily: 'unix', platformOs: 'macos' } });
    case 'initialized':
      return;
    case 'config/read':
      return send({ id, result: { config: { mcp_servers: { logs: {}, mail: {} }, plugins: { 'browser@bundled': { enabled: true } } } } });
    case 'thread/start':
      instructions = params.developerInstructions;
      Object.assign(setup, { sandbox: params.sandbox, approvalPolicy: params.approvalPolicy, dynamicTools: params.dynamicTools, config: params.config });
      return send({ id, result: { thread: { id: THREAD }, model: 'fake', cwd: params.cwd } });
    case 'thread/resume':
      if (params.threadId !== THREAD) {
        return send({ id, error: { code: -32600, message: `no rollout found for thread id ${params.threadId}` } });
      }
      return send({ id, result: { thread: { id: THREAD }, model: 'fake' } });
    case 'turn/start': {
      // Like the real server, answer before the turn is active and announce it a moment later.
      const turnId = `turn-${++turnCount}`;
      lastTurn = params;
      send({ id, result: { turn: { id: turnId, items: [], status: 'inProgress', error: null } } });
      setTimeout(() => {
        activeTurn = turnId;
        notify('turn/started', { turn: { id: turnId } });
        void runTurn(params.input.find((input) => input.type === 'text').text);
      }, 5);
      return;
    }
    case 'model/list':
      return send({
        id,
        result: {
          data: [
            { id: 'm1', model: 'gpt-fast', displayName: 'Fast', description: 'Quick', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }, { reasoningEffort: 'high', description: '' }], defaultReasoningEffort: 'low', isDefault: true },
            { id: 'm2', model: 'gpt-hidden', displayName: 'Hidden', description: '', hidden: true, supportedReasoningEfforts: [], defaultReasoningEffort: 'low', isDefault: false },
          ],
          nextCursor: null,
        },
      });
    case 'skills/list':
      return send({
        id,
        result: {
          data: [
            {
              cwd: params.cwds[0],
              skills: [
                { name: 'summarize', description: 'Long text', shortDescription: 'Summarize a note', path: '/skills/summarize/SKILL.md', enabled: true },
                { name: 'off', description: 'Disabled', path: '/skills/off/SKILL.md', enabled: false },
              ],
              errors: [],
            },
          ],
        },
      });
    case 'turn/interrupt':
      if (activeTurn !== params.turnId) {
        return send({ id, error: { code: -32600, message: 'no active turn to interrupt' } });
      }
      send({ id, result: {} });
      complete('interrupted');
      return;
    default:
      return send({ id, error: { code: -32601, message: `unknown method ${method}` } });
  }
});
