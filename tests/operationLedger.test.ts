import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { OperationLedger } from '../backend/operationLedger.ts';
import { withOperationIdentity } from '../src/data/operationIdentity.ts';

const run = async (name: string, test: () => Promise<void>) => { await test(); console.log(`PASS ${name}`); };
await mkdir('.tmp-tests', { recursive: true });
const directory = await mkdtemp(path.resolve('.tmp-tests', 'operations-'));
const ledger = new OperationLedger(directory);

await run('concurrent duplicate operations execute once and completed results survive restart', async () => {
  let calls = 0;
  const execute = async () => {
    calls += 1;
    assert.equal((await ledger.get('same-request'))?.status, 'started');
    return { queued: { assistantMessageId: 'reply-1' } };
  };
  const [a, b] = await Promise.all([
    ledger.execute('same-request', 'sendMessage', { prompt: 'hello', sessionId: 's' }, execute),
    ledger.execute('same-request', 'sendMessage', { sessionId: 's', prompt: 'hello' }, execute),
  ]);
  assert.deepEqual(a, b);
  assert.equal(calls, 1);
  const reopened = new OperationLedger(directory);
  assert.deepEqual(await reopened.execute('same-request', 'sendMessage', { prompt: 'hello', sessionId: 's' }, execute), a);
  assert.equal(calls, 1);
});

await run('reusing an operation ID with different input is rejected', async () => {
  await assert.rejects(ledger.execute('same-request', 'sendMessage', { prompt: 'different' }, async () => 'bad'), /EAF_OPERATION_CONFLICT/);
});

await run('an interrupted operation is never executed again after restart', async () => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const original = ledger.execute('interrupted', 'sendMessage', {}, async () => { entered(); await ready; return 'eventually completed'; });
  await started;
  const restarted = new OperationLedger(directory);
  await assert.rejects(restarted.execute('interrupted', 'sendMessage', {}, async () => { throw new Error('must not execute'); }), /EAF_OPERATION_UNCERTAIN/);
  release();
  await original;
});

await run('failure after a side effect is recorded as uncertain and cannot be retried blindly', async () => {
  let effects = 0;
  const operation = async () => { effects += 1; throw new Error('confirmation lost'); };
  await assert.rejects(ledger.execute('uncertain', 'approve', {}, operation), /EAF_OPERATION_UNCERTAIN/);
  await assert.rejects(new OperationLedger(directory).execute('uncertain', 'approve', {}, operation), /EAF_OPERATION_UNCERTAIN/);
  assert.equal(effects, 1);
  assert.equal((await ledger.get('uncertain'))?.status, 'uncertain');
});

await run('invalid operation paths are rejected before executing', async () => {
  let called = false;
  await assert.rejects(ledger.execute('../escape', 'sendMessage', {}, async () => { called = true; }), /EAF_INVALID_OPERATION/);
  assert.equal(called, false);
});

await run('the original input is durable before dispatch and is isolated from caller mutation', async () => {
  const input = { sessionId: 's', prompt: 'original input' };
  const submitted = ledger.execute('captured-input', 'sendMessage', input, async (captured) => {
    const record = await ledger.get('captured-input');
    assert.deepEqual(record?.payload, { sessionId: 's', prompt: 'original input' });
    assert.deepEqual(captured, record?.payload);
    (captured as { prompt: string }).prompt = 'handler mutation';
    return 'accepted';
  });
  input.prompt = 'mutated by caller';
  await submitted;
  assert.deepEqual((await new OperationLedger(directory).get('captured-input'))?.payload, { sessionId: 's', prompt: 'original input' });
});

await run('renderer retries and reloads reuse operation IDs without storing prompt content', async () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const ids: string[] = [];
  let fail = true;
  const raw = { sendMessage: async (payload: Record<string, unknown>) => {
    assert.equal(payload.session, undefined);
    ids.push(payload.operationId as string);
    if (fail) throw new Error('EAF_TRANSPORT_RETRYABLE: disconnected');
    return 'received';
  } };
  const first = withOperationIdentity(raw, storage);
  await assert.rejects(first.sendMessage({ sessionId: 's', prompt: 'private-text', session: { updatedAt: 1 } }), /disconnected/);
  assert.equal(ids[0], ids[1]);
  assert.equal(JSON.stringify([...values]).includes('private-text'), false);
  fail = false;
  const reloaded = withOperationIdentity(raw, storage);
  await reloaded.sendMessage({ session: { updatedAt: 999 }, prompt: 'private-text', sessionId: 's' });
  assert.equal(ids[2], ids[0]);
  assert.equal(values.size, 0);
  await reloaded.sendMessage({ sessionId: 's', prompt: 'private-text' });
  assert.notEqual(ids[3], ids[2]);
});

await run('operation identity also works on HTTP origins without SubtleCrypto or randomUUID', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const random = crypto.getRandomValues.bind(crypto);
  try {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues: random } });
    const bridge = withOperationIdentity({ sendMessage: async (payload: Record<string, unknown>) => payload.operationId });
    assert.match(String(await bridge.sendMessage({ prompt: 'test' })), /^[a-f0-9]{32}$/);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
  }
});
