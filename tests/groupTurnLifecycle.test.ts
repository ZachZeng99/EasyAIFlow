import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { configureRuntimePaths } from '../backend/runtimePaths.ts';
import { CodexAppServerClient } from '../backend/codexAppServer.ts';
import { createClaudeInteractionState } from '../backend/claudeInteractionState.ts';
import { sendGroupMessage, stopGroupSessionRuns, hasActiveGroupTurns } from '../backend/groupChat.ts';
import { runCodexAppServerTurn, interruptCodexAppServerTurn } from '../backend/codexAppServerTurn.ts';
import * as store from '../electron/sessionStore.ts';
import type { ClaudeInteractionContext } from '../backend/claudeInteractionContext.ts';
import type { ClaudeStreamEvent } from '../src/data/types.ts';

const defer = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const waitFor = async (condition: () => boolean | Promise<boolean>) => {
  const deadline = Date.now() + 15000;
  while (!(await condition())) {
    assert.ok(Date.now() < deadline, 'Timed out waiting for lifecycle transition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

await mkdir('.tmp-tests', { recursive: true });
const root = await mkdtemp(path.resolve('.tmp-tests', 'group-lifecycle-'));
const data = path.join(root, 'data');
const home = path.join(root, 'home');
const workspace = path.join(root, 'workspace');
await Promise.all([data, home, workspace].map((directory) => mkdir(directory)));
await writeFile(path.join(data, 'easyaiflow-sessions.json'), JSON.stringify({ projects: [], deletedImports: { claudeSessionIds: [], codexThreadIds: [] } }));
configureRuntimePaths({ mode: 'web', userDataPath: data, homePath: home });

type Notification = { method: string; params: Record<string, unknown> };
class FakeClient {
  handlers = new Set<(event: Notification) => void>();
  prompt = '';
  interrupted = 0;
  closed = 0;
  startGate?: ReturnType<typeof defer<{ turn: { id: string; status: string } }>>;
  threadStart = async () => ({ thread: { id: 'thread' } });
  threadResume = this.threadStart;
  threadSetName = async () => undefined;
  addNotificationHandler = (fn: (event: Notification) => void) => { this.handlers.add(fn); };
  removeNotificationHandler = (fn: (event: Notification) => void) => { this.handlers.delete(fn); };
  addExitHandler = () => undefined;
  removeExitHandler = () => undefined;
  close = async () => { this.closed++; };
  turnStart = async ({ prompt }: { prompt: string }) => {
    this.prompt = prompt;
    return this.startGate ? this.startGate.promise : { turn: { id: 'turn', status: 'inProgress' } };
  };
  turnInterrupt = async () => { this.interrupted++; };
  finish(text: string) {
    for (const handler of this.handlers) {
      handler({ method: 'item/completed', params: { threadId: 'thread', turnId: 'turn', item: { id: 'reply', type: 'agentMessage', phase: 'final_answer', text } } });
      handler({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } } });
    }
  }
}
const clients: FakeClient[] = [];
const originalCreate = CodexAppServerClient.create;
let delayNextStart = false;
CodexAppServerClient.create = async () => {
  const client = new FakeClient();
  if (delayNextStart) { delayNextStart = false; client.startGate = defer(); }
  clients.push(client);
  return client as unknown as CodexAppServerClient;
};
const state = createClaudeInteractionState();
const events: ClaudeStreamEvent[] = [];
const ctx: ClaudeInteractionContext = { broadcastEvent: (event) => events.push(event), attachmentRoot: () => root, claudeSettingsPath: () => path.join(root, 'settings.json'), homePath: () => home };
let success = false;
try {
  const project = await store.createProject('Group lifecycle', workspace);
  const room = await store.createSessionInStreamwork(project.session.dreamId, 'Room', false, 'claude', 'group');
  const roomId = room.session.id;
  const send = (prompt: string) => sendGroupMessage(ctx, state, { sessionId: roomId, prompt: `@codex ${prompt}` });
  const first = await send('First request');
  await waitFor(() => Boolean(clients[0]?.prompt));
  const second = await send('Second request');
  assert.equal(clients.length, 1, 'Queued member must not open a second runtime');
  assert.equal(hasActiveGroupTurns(state), true);
  clients[0].finish('FIRST_REPLY');
  await waitFor(() => Boolean(clients[1]?.prompt));
  assert.doesNotMatch(clients[1].prompt, /FIRST_REPLY/, 'Context was frozen while the earlier reply was still pending');
  assert.ok(!events.some((event) => event.type === 'runtime-state' && event.sessionId === roomId && !event.sourceSessionId && event.runtime.phase === 'inactive'));
  clients[1].finish('SECOND_REPLY');
  await waitFor(() => !hasActiveGroupTurns(state));
  const record = await store.getSessionRecordForBootstrap(roomId);
  assert.equal(record?.messages.find((message) => message.id === first.queued.assistantMessageId)?.content, 'FIRST_REPLY');
  assert.equal(record?.messages.find((message) => message.id === second.queued.assistantMessageId)?.content, 'SECOND_REPLY');
  console.log('PASS overlapping room turns keep IDs, context and aggregate activity');

  await send('Third request');
  await waitFor(() => Boolean(clients[2]?.prompt));
  assert.match(clients[2].prompt, /FIRST_REPLY/);
  assert.match(clients[2].prompt, /SECOND_REPLY/);
  const queued = await send('Must never reach CLI');
  await stopGroupSessionRuns(ctx, state, roomId);
  assert.equal(clients.length, 3);
  assert.equal(clients[2].interrupted, 1);
  const stopped = await store.getSessionRecordForBootstrap(roomId);
  assert.ok(stopped?.messages.every((message) => !['queued', 'streaming', 'running'].includes(message.status ?? '')));
  assert.match(stopped?.messages.find((message) => message.id === queued.queued.assistantMessageId)?.content ?? '', /Stopped/);
  assert.equal(hasActiveGroupTurns(state), false);
  console.log('PASS stop cancels pending group turns and uses the owning Codex client');

  delayNextStart = true;
  await send('Stop while turn start is awaiting acknowledgement');
  await waitFor(() => Boolean(clients[3]?.prompt));
  const stopping = stopGroupSessionRuns(ctx, state, roomId);
  await waitFor(() => clients[3].closed > 0);
  clients[3].startGate!.resolve({ turn: { id: 'turn', status: 'inProgress' } });
  await stopping;
  assert.equal(clients[3].interrupted, 1, 'Late turn ID still receives interruption on its own client');
  console.log('PASS delayed turn acknowledgement cannot escape cancellation');

  const standalone = await store.createSession(project.session.id, false, 'codex');
  let preparedId = '';
  const preparing = runCodexAppServerTurn(ctx, standalone.session.id, 'Preparation race', [], undefined, { onPrepared: (id) => { preparedId = id; } });
  await assert.rejects(runCodexAppServerTurn(ctx, standalone.session.id, 'Duplicate during prepare'), /already running/);
  await interruptCodexAppServerTurn(ctx, standalone.session.id);
  const cancelled = await preparing;
  assert.equal(clients.length, 4, 'Cancelled preparation must not launch a runtime');
  assert.equal(preparedId, cancelled.queued.assistantMessageId);
  console.log('PASS Codex reserves before async preparation and honors stop before launch');
  success = true;
} finally {
  CodexAppServerClient.create = originalCreate;
  await store.flushPendingSave();
  if (success) {
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(`${path.resolve('.tmp-tests')}${path.sep}`));
    await rm(resolved, { recursive: true, force: true });
  } else console.error(`Lifecycle artifacts: ${root}`);
}
