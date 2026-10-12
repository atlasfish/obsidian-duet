// Local MCP server for testing the real Codex tool allow list. No external effects.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'duet-inline-test', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ['read_logs', 'delete_logs'].map((name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } })) }));
server.setRequestHandler(CallToolRequestSchema, async (request) => ({ content: [{ type: 'text', text: request.params.name }] }));
await server.connect(new StdioServerTransport());
process.stdin.on('end', () => { void server.close(); });
