import assert from 'node:assert/strict';
import { OperationError } from '../backend/operationLedger.ts';
import { createRemoteEventHub, type RemoteExecutionPort } from '../backend/remoteExecution.ts';
import { runRemoteMemberTurn } from '../backend/remoteGroupMember.ts';
import type { ClaudeStreamEvent, ConversationMessage } from '../src/data/types.ts';

const run = async (name: string, test: () => Promise<void>) => {
  try { await test(); console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}`); throw error; }
};

const DEVICE = '11111111-2222-3333-4444-555555555555';
const SESSION = 'remote-session';
type Call = { method: string; payload: unknown; operationId?: string };

const fakePort = (handler: (call: Call) => unknown | Promise<unknown>) => {
  const hub = createRemoteEventHub();
  const calls: Call[] = [];
  const port: RemoteExecutionPort = {
    request: async <T>(_device: string, method: string, payload?: unknown, operationId?: string) => {
      const call = { method, payload, operationId };
      calls.push(call);
      return await handler(call) as T;
    },
    subscribe: hub.subscribe,
    describe: () => undefined,
  };
  const emit = (event: ClaudeStreamEvent) => hub.publish({ ...event, deviceId: DEVICE });
  return { port, calls, emit };
};
const message = (id: string, status: ConversationMessage['status'], content: string): ConversationMessage =>
  ({ id, role: 'assistant', timestamp: '', title: '', content, status });
const page = (messages: ConversationMessage[]) => ({ sessionId: SESSION, pageId: 'p', messages, hasMoreBefore: false, sessionRevision: 1 });

await run('events that arrive before the submit response are mirrored in order after the reply ID is known', async () => {
  let emitEarly: () => void = () => undefined;
  const { port, emit } = fakePort(({ method }) => {
    if (method === 'sendMessage') { emitEarly(); return { queued: { assistantMessageId: 'reply-1' } }; }
    return page([]);
  });
  emitEarly = () => {
    emit({ type: 'delta', sessionId: SESSION, messageId: 'reply-1', delta: 'A' });
    emit({ type: 'delta', sessionId: 'other-session', messageId: 'reply-1', delta: 'X' });
    emit({ type: 'permission-request', sessionId: SESSION, requestId: 'r', toolName: 't', sensitive: false });
    emit({ type: 'delta', sessionId: SESSION, messageId: 'reply-1', delta: 'B' });
  };
  const seen: string[] = [];
  const outcome = await runRemoteMemberTurn({
    port, deviceId: DEVICE, sessionId: SESSION, prompt: 'p', operationId: 'op-1', signal: new AbortController().signal, pollIntervalMs: 20,
    onEvent: (event) => {
      assert.equal('deviceId' in event, false);
      seen.push(event.type === 'delta' ? event.delta : event.type);
      if (event.type === 'delta' && event.delta === 'B') setTimeout(() => emit({ type: 'complete', sessionId: SESSION, messageId: 'reply-1', content: 'AB' }), 5);
    },
  });
  assert.deepEqual(seen.slice(0, 2), ['A', 'B']);
  assert.ok(!seen.includes('X') && !seen.includes('permission-request'));
  assert.deepEqual(outcome, { status: 'complete', content: 'AB', assistantMessageId: 'reply-1' });
});

await run('a lost terminal event is recovered from the executor persisted record', async () => {
  let polls = 0;
  const { port } = fakePort(({ method }) => {
    if (method === 'sendMessage') return { queued: { assistantMessageId: 'reply-2' } };
    polls += 1;
    if (polls === 1) throw new OperationError('EAF_TRANSPORT_RETRYABLE', 'offline');
    return page([message('reply-2', polls < 3 ? 'streaming' : 'complete', 'FINAL')]);
  });
  const outcome = await runRemoteMemberTurn({ port, deviceId: DEVICE, sessionId: SESSION, prompt: 'p', operationId: 'op-2', signal: new AbortController().signal, pollIntervalMs: 10, onEvent: () => undefined });
  assert.deepEqual(outcome, { status: 'complete', content: 'FINAL', assistantMessageId: 'reply-2' });
});

await run('older pages are searched when the reply is no longer on the last page', async () => {
  const { port } = fakePort(({ method, payload }) => {
    if (method === 'sendMessage') return { queued: { assistantMessageId: 'reply-3' } };
    const before = (payload as { before?: string }).before;
    return before === 'older'
      ? page([message('reply-3', 'error', 'CLI failed')])
      : { ...page([message('later', 'complete', 'trace')]), hasMoreBefore: true, nextBefore: 'older' };
  });
  const outcome = await runRemoteMemberTurn({ port, deviceId: DEVICE, sessionId: SESSION, prompt: 'p', operationId: 'op-3', signal: new AbortController().signal, pollIntervalMs: 10, onEvent: () => undefined });
  assert.deepEqual(outcome, { status: 'error', content: 'CLI failed', assistantMessageId: 'reply-3' });
});

await run('transport failures retry submission with the same operation ID only', async () => {
  let attempts = 0;
  const { port, calls } = fakePort(({ method }) => {
    if (method === 'sendMessage') {
      attempts += 1;
      if (attempts < 3) throw new OperationError('EAF_TRANSPORT_RETRYABLE', 'offline');
      return { queued: { assistantMessageId: 'reply-4' } };
    }
    return page([message('reply-4', 'complete', 'ok')]);
  });
  await runRemoteMemberTurn({ port, deviceId: DEVICE, sessionId: SESSION, prompt: 'p', model: 'm', effort: 'high', operationId: 'op-4', signal: new AbortController().signal, pollIntervalMs: 10, onEvent: () => undefined });
  const sends = calls.filter((call) => call.method === 'sendMessage');
  assert.equal(sends.length, 3);
  assert.ok(sends.every((call) => call.operationId === 'op-4'));
  assert.deepEqual(sends[0].payload, { sessionId: SESSION, prompt: 'p', model: 'm', effort: 'high' });
});

await run('non-transport rejections are not retried', async () => {
  const { port, calls } = fakePort(() => { throw new OperationError('EAF_OPERATION_UNCERTAIN', 'uncertain'); });
  await assert.rejects(runRemoteMemberTurn({ port, deviceId: DEVICE, sessionId: SESSION, prompt: 'p', operationId: 'op-5', signal: new AbortController().signal, onEvent: () => undefined }), /uncertain/);
  assert.equal(calls.length, 1);
});

await run('an unconfirmed submission reports the uncertainty instead of resending forever', async () => {
  const { port } = fakePort(() => { throw new OperationError('EAF_TRANSPORT_RETRYABLE', 'offline'); });
  await assert.rejects(runRemoteMemberTurn({ port, deviceId: DEVICE, sessionId: SESSION, prompt: 'p', operationId: 'op-6', signal: new AbortController().signal, submitWindowMs: 1500, onEvent: () => undefined }), /未确认.*未自动重发/);
});

await run('stopping a running remote turn stops the executor session with a derived operation ID', async () => {
  const controller = new AbortController();
  const { port, calls } = fakePort(({ method }) => {
    if (method === 'sendMessage') { setTimeout(() => controller.abort(), 30); return { queued: { assistantMessageId: 'reply-7' } }; }
    if (method === 'stopSessionRun') return null;
    return page([message('reply-7', 'streaming', '')]);
  });
  const outcome = await runRemoteMemberTurn({ port, deviceId: DEVICE, sessionId: SESSION, prompt: 'p', operationId: 'op-7', signal: controller.signal, pollIntervalMs: 5000, onEvent: () => undefined });
  assert.deepEqual(outcome, { status: 'stopped', assistantMessageId: 'reply-7' });
  const stop = calls.find((call) => call.method === 'stopSessionRun');
  assert.deepEqual(stop, { method: 'stopSessionRun', payload: { sessionId: SESSION }, operationId: 'op-7:stop' });
});

await run('a reconnect notification triggers an immediate status check', async () => {
  let polls = 0;
  let emitSync: () => void = () => undefined;
  const { port, emit } = fakePort(({ method }) => {
    if (method === 'sendMessage') return { queued: { assistantMessageId: 'reply-8' } };
    polls += 1;
    if (polls === 1) setTimeout(() => emitSync(), 20);
    return page([message('reply-8', polls >= 2 ? 'complete' : 'streaming', 'done')]);
  });
  emitSync = () => emit({ type: 'interaction-sync' } as ClaudeStreamEvent);
  const started = Date.now();
  const outcome = await runRemoteMemberTurn({ port, deviceId: DEVICE, sessionId: SESSION, prompt: 'p', operationId: 'op-8', signal: new AbortController().signal, pollIntervalMs: 60000, onEvent: () => undefined });
  assert.equal(outcome.status, 'complete');
  assert.ok(Date.now() - started < 5000);
});
