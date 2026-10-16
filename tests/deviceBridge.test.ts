import assert from 'node:assert/strict';
import { withOperationIdentity } from '../src/data/operationIdentity.ts';

const values = new Map<string, string>();
const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
const ids: string[] = [];
let rejected = true;
const raw = { sendMessage: async (payload: Record<string, unknown>) => {
  ids.push(String(payload.operationId));
  if (rejected) throw new Error('EAF_AUTH_REQUIRED: login again');
  return 'sent';
} };
const a = withOperationIdentity(raw, storage, 'computer-a');
const b = withOperationIdentity(raw, storage, 'computer-b');
await assert.rejects(a.sendMessage({ sessionId: 'same-id', prompt: 'same-text' }), /AUTH_REQUIRED/);
await assert.rejects(b.sendMessage({ sessionId: 'same-id', prompt: 'same-text' }), /AUTH_REQUIRED/);
assert.notEqual(ids[0], ids[1]);
rejected = false;
await withOperationIdentity(raw, storage, 'computer-a').sendMessage({ sessionId: 'same-id', prompt: 'same-text' });
assert.equal(ids[0], ids[2]);
assert.equal(values.size, 1);
console.log('PASS per-device pending operations remain isolated and survive login/reload');

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
const frames: Array<{ deviceId?: string; method: string; operationId?: string }> = [];
let release!: () => void;
const gate = new Promise<void>((resolve) => { release = resolve; });
let first = true;
globalThis.fetch = async (_input, init) => {
  const frame = JSON.parse(String(init?.body)); frames.push(frame);
  if (frame.method === 'sendMessage' && frame.deviceId === 'computer-a' && first) {
    first = false; await gate; throw new Error('connection dropped');
  }
  return new Response(JSON.stringify({ device: frame.deviceId }), { status: 200 });
};
const streams: FakeEventSource[] = [];
class FakeEventSource {
  onmessage?: (event: { data: string }) => void;
  onopen?: () => void;
  closed = false;
  constructor(public url: string) { streams.push(this); }
  close() { this.closed = true; }
}
globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
try {
  const { bridgeForDevice, bridge } = await import('../src/bridge.ts');
  const bridgeA = bridgeForDevice('computer-a');
  const pending = bridgeA.sendMessage({ sessionId: 'session', prompt: 'hello' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const bridgeB = bridgeForDevice('computer-b');
  await bridgeB.getProjects();
  release(); await pending;
  assert.deepEqual(frames.map((frame) => frame.deviceId), ['computer-a', 'computer-b', 'computer-a']);
  assert.equal(frames[0].operationId, frames[2].operationId);
  console.log('PASS switching the visible device never reroutes a pending retry');

  const localEvents: string[] = []; const aEvents: string[] = []; const bEvents: string[] = [];
  const unsubscribers = [bridge.onClaudeEvent((event) => localEvents.push(event.type)), bridgeA.onClaudeEvent((event) => aEvents.push(event.type)), bridgeB.onClaudeEvent((event) => bEvents.push(event.type))];
  for (const stream of streams) for (const deviceId of [undefined, 'computer-a', 'computer-b']) stream.onmessage?.({ data: JSON.stringify({ type: deviceId ? 'status' : 'interaction-sync', deviceId }) });
  assert.deepEqual(localEvents, ['interaction-sync']);
  assert.deepEqual(aEvents, ['status']); assert.deepEqual(bEvents, ['status']);
  assert.ok(streams[1].url.endsWith('?deviceId=computer-a'));
  unsubscribers.forEach((unsubscribe) => unsubscribe());
  assert.ok(streams.every((stream) => stream.closed));
  console.log('PASS subscriptions and delayed events remain inside their device workspace');
} finally { globalThis.fetch = originalFetch; globalThis.EventSource = originalEventSource; }
