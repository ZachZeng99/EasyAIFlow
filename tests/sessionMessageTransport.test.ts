import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { onSessionMessagesCommitted, publishSessionMessagesCommitted } from '../backend/sessionMessageEvents.ts';
import { migrateSessionStoreV2 } from '../electron/sessionStoreV2.ts';
import { createSseClientRegistry } from '../server/sseClients.ts';
import { applyCommittedSessionMessages, requireMessageSnapshot } from '../src/data/committedSessionMessages.ts';
import { mergeSessionSnapshot } from '../src/data/projectSnapshots.ts';
import type { SessionStoreAppState } from '../electron/sessionStoreMerge.ts';
import type { ConversationMessage, SessionMessagesCommittedEvent, SessionRecord } from '../src/data/types.ts';

const message = (content: string): ConversationMessage => ({
  id: 'a', content, role: 'assistant', title: 'Reply', timestamp: 'now', status: 'streaming',
});
const initial: SessionRecord = {
  id: 's', title: 'Session', preview: '', timeLabel: 'now', updatedAt: 1,
  model: 'test', workspace: 'X:/repo', projectId: 'p', projectName: 'Project',
  dreamId: 'd', dreamName: 'Main', groups: [], messages: [message('start')],
  tokenUsage: { contextWindow: 0, used: 0, input: 0, output: 0, cached: 0 },
  branchSnapshot: { branch: 'main', ahead: 0, behind: 0, dirty: false, changedFiles: [] },
};
const state: SessionStoreAppState = {
  projects: [{ id: 'p', name: 'Project', rootPath: 'X:/repo', dreams: [{ id: 'd', name: 'Main', sessions: [initial] }] }],
  deletedImports: { claudeSessionIds: [], codexThreadIds: [] },
};
const base = path.resolve('.tmp-tests');
await mkdir(base, { recursive: true });
const directory = await mkdtemp(path.join(base, 'message-transport-'));
const store = await migrateSessionStoreV2(directory, state, { maxMessages: 0, onMessagesCommitted: publishSessionMessagesCommitted });
const snapshot = async (): Promise<SessionRecord> => {
  const page = await store.readMessagePage('s');
  return { ...initial, messages: page.messages, messagesLoaded: true, messageRevision: page.sessionRevision };
};
let desktop = await snapshot();
let mobile = desktop;
const clients = createSseClientRegistry();
const removeSse = onSessionMessagesCommitted((event) => clients.broadcastEvent(event));
const removeDesktop = onSessionMessagesCommitted((event) => {
  desktop = applyCommittedSessionMessages(desktop, structuredClone(event));
});
let releaseSnapshot: (() => void) | undefined;
let snapshotStarted: (() => void) | undefined;
const server = createServer(async (request, response) => {
  if (request.url === '/events') {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    clients.add(response);
    clients.writeComment(response, 'connected');
    response.on('close', () => clients.remove(response));
    return;
  }
  const value = await snapshot();
  if (snapshotStarted) {
    const wait = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
    snapshotStarted();
    snapshotStarted = undefined;
    await wait;
  }
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
const origin = `http://127.0.0.1:${address.port}`;
const controllers: AbortController[] = [];
const connect = async () => {
  const controller = new AbortController();
  controllers.push(controller);
  const response = await fetch(`${origin}/events`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]) });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return {
    close: () => controller.abort(),
    next: async (): Promise<SessionMessagesCommittedEvent> => {
      while (true) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (frame.startsWith('data: ')) return JSON.parse(frame.slice(6));
          continue;
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error('SSE closed before the expected event');
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    },
  };
};
const persist = (content: string) => store.persist(state, {
  sessionMutations: [{ type: 'upsert-message', sessionId: 's', message: message(content) }],
  immediateIndex: true,
});

try {
  let connection = await connect();
  await persist('first');
  mobile = applyCommittedSessionMessages(mobile, await connection.next());
  assert.deepEqual(mobile.messages, desktop.messages);

  const captured = new Promise<void>((resolve) => { snapshotStarted = resolve; });
  const delayed = fetch(`${origin}/snapshot`).then((response) => response.json() as Promise<SessionRecord>);
  await captured;
  await persist('second');
  mobile = applyCommittedSessionMessages(mobile, await connection.next());
  releaseSnapshot!();
  mobile = mergeSessionSnapshot(mobile, await delayed);
  assert.equal(mobile.messages[0].content, 'second');
  console.log('PASS delayed HTTP snapshots cannot overwrite newer SSE commits');

  connection.close();
  await persist('missed while offline');
  connection = await connect();
  await persist('after reconnect');
  mobile = applyCommittedSessionMessages(mobile, await connection.next());
  assert.ok(mobile.requiredMessageRevision);
  const recovered = await fetch(`${origin}/snapshot`).then((response) => response.json() as Promise<SessionRecord>);
  mobile = mergeSessionSnapshot(mobile, recovered);
  assert.deepEqual(mobile.messages, desktop.messages);
  assert.equal(mobile.requiredMessageRevision, undefined);
  console.log('PASS SSE disconnect and reconnect recover missed messages to match the desktop subscriber');

  // Reconnect without a subsequent event also requires a snapshot, as onopen
  // does in the real bridge; otherwise a missing final reply would stay lost.
  connection.close();
  await persist('final while offline');
  mobile = requireMessageSnapshot(mobile, mobile.messageRevision!);
  mobile = mergeSessionSnapshot(mobile, await snapshot());
  assert.equal(mobile.messages[0].content, 'final while offline');
  assert.deepEqual(mobile.messages, desktop.messages);
  console.log('PASS reconnect recovers a terminal update even when no later event arrives');
} finally {
  releaseSnapshot?.();
  for (const controller of controllers) controller.abort();
  removeSse();
  removeDesktop();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await store.flush(state);
}
