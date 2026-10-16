// Only JSON-RPC goes to stdout. This subprocess has a single active-member
// capability and connects to the local device pipe, never to a public endpoint.
import { readFile } from 'node:fs/promises';
import { DeviceServiceClient } from './deviceServiceClient.js';

const linkPath = process.env.EAF_AGENT_LINK;
if (!linkPath) throw new Error('Missing EAF agent link.');
const link = JSON.parse(await readFile(linkPath, 'utf8')) as { dataDirectory: string; token: string };
const client = new DeviceServiceClient({ dataDirectory: link.dataDirectory, autoStart: false });
const tools = [
  { name: 'team_members', description: 'List the enabled EAF group members you may delegate to. These are independent sessions, not native subagents.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'team_send', description: 'Delegate work to another enabled EAF group member. Returns a durable delivery_id and queued status, not a completed result. Reuse request_id only for retries of the same request. Use team_wait for the actual reply. Do not send to yourself or an ancestor.', inputSchema: { type: 'object', properties: { recipient: { type: 'string' }, message: { type: 'string', maxLength: 16000 }, request_id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,64}$' } }, required: ['recipient', 'message', 'request_id'], additionalProperties: false } },
  { name: 'team_wait', description: 'Wait up to 20 seconds for a delivery you sent. Returns queued/running/replied/failed/unknown and the actual reply when available. Pending is not success; call again if the task still needs the result. Do not create dependency cycles.', inputSchema: { type: 'object', properties: { delivery_id: { type: 'string' } }, required: ['delivery_id'], additionalProperties: false } },
];
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
let pending = 0;
const handle = async (frame: { id?: string | number; method?: string; params?: Record<string, unknown> }) => {
  if (frame.id === undefined) return;
  if (pending >= 8) { send({ jsonrpc: '2.0', id: frame.id, error: { code: -32000, message: 'Too many concurrent tool requests.' } }); return; }
  pending++;
  try {
    let result: unknown;
    if (frame.method === 'initialize') result = { protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'].includes(String(frame.params?.protocolVersion)) ? frame.params!.protocolVersion : '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'EAF team', version: '2.0.0-alpha.1' } };
    else if (frame.method === 'ping') result = {};
    else if (frame.method === 'tools/list') result = { tools };
    else if (frame.method === 'resources/list') result = { resources: [] };
    else if (frame.method === 'prompts/list') result = { prompts: [] };
    else if (frame.method === 'tools/call') {
      try {
        if (!tools.some((tool) => tool.name === frame.params?.name)) throw new Error('Unknown EAF team tool.');
        const output = await client.request('callAgentTeamTool', { token: link.token, name: frame.params?.name, arguments: frame.params?.arguments });
        result = { content: [{ type: 'text', text: JSON.stringify(output) }] };
      } catch (error) { result = { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'EAF team tool failed.' }] }; }
    } else { send({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'Unsupported MCP method.' } }); return; }
    send({ jsonrpc: '2.0', id: frame.id, result });
  } finally { pending--; }
};
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  if (Buffer.byteLength(buffer) > 256 * 1024) { client.close(); process.exit(1); }
  let boundary: number;
  while ((boundary = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
    if (!line.trim()) continue;
    try { const frame = JSON.parse(line); if (frame && typeof frame === 'object') void handle(frame).catch(() => process.exit(1)); }
    catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON.' } }); }
  }
});
process.stdin.on('end', () => { client.close(); process.exit(0); });
process.stdout.on('error', () => { client.close(); process.exit(0); });
