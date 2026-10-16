import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NativeAgentProjection } from '../backend/nativeAgentProjection.ts';
import { collectNativeAgents, mergeNativeAgentMessages } from '../src/data/nativeAgents.ts';
import { buildDisplayItems } from '../src/data/chatThreadDisplay.ts';
import { recoverStaleSessionMessagesForProvider } from '../electron/sessionRecovery.ts';
import { parseClaudeBackgroundTaskEvent } from '../electron/backgroundTaskNotification.ts';
import { isActiveBackgroundTask } from '../src/data/sessionInteraction.ts';
import { configureRuntimePaths } from '../backend/runtimePaths.ts';
import { createClaudeInteractionState } from '../backend/claudeInteractionState.ts';
import { handleClaudeLine } from '../backend/claudeInteraction.ts';
import { CodexAppServerClient } from '../backend/codexAppServer.ts';
import { runCodexAppServerTurn, interruptCodexAppServerTurn } from '../backend/codexAppServerTurn.ts';
import { createMirroredContext } from '../backend/groupChat.ts';
import * as store from '../electron/sessionStore.ts';
import type { ConversationMessage } from '../src/data/types.ts';

const run = async (name: string, test: () => unknown | Promise<unknown>) => { await test(); console.log(`PASS ${name}`); };
const recordedClaude = JSON.parse(await readFile('tests/fixtures/claude-2.1.284-native-agent.json', 'utf8'));
const recordedCodex = JSON.parse(await readFile('tests/fixtures/codex-0.163-native-agent.json', 'utf8'));
const latest = (projector: NativeAgentProjection, frames: Array<Record<string, unknown>>) => {
  const messages = new Map<string, ConversationMessage>();
  for (const frame of frames) {
    projector.observeClaude(frame, 'root-answer');
    projector.drain().forEach((message) => messages.set(message.id, message));
  }
  return [...messages.values()];
};

await run('recorded Claude child messages have one durable identity and never become root output', () => {
  const projection = new NativeAgentProjection('claude', 'session');
  const messages = latest(projection, recordedClaude);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].content, 'CHILD_NATIVE_OK');
  assert.equal(messages[0].nativeAgent?.status, 'completed');
  assert.ok(messages[0].nativeAgent?.nativeTaskId);
  assert.equal(buildDisplayItems(messages).length, 0);
  assert.equal(latest(projection, recordedClaude).length, 0, 'Replayed provider frames must be idempotent');
});

await run('nested Claude agents preserve parent links and replace streamed text with authoritative snapshots', () => {
  const projection = new NativeAgentProjection('claude', 'session');
  const frames = [
    { type: 'assistant', uuid: 'a', message: { content: [{ type: 'tool_use', name: 'Agent', id: 'parent', input: { description: 'Parent' } }] } },
    { type: 'assistant', uuid: 'b', parent_tool_use_id: 'parent', message: { content: [{ type: 'tool_use', name: 'Agent', id: 'child', input: { description: 'Nested child' } }] } },
    { type: 'stream_event', uuid: 'c', parent_tool_use_id: 'child', event: { type: 'message_start', message: { id: 'output' } } },
    { type: 'stream_event', uuid: 'd', parent_tool_use_id: 'child', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } } },
    { type: 'assistant', uuid: 'e', parent_tool_use_id: 'child', message: { id: 'output', content: [{ type: 'text', text: 'hello world' }] } },
  ];
  const messages = latest(projection, frames);
  const tree = collectNativeAgents(messages);
  assert.deepEqual(tree.map((node) => node.depth), [0, 1]);
  assert.equal(tree[1].agent.parentId, tree[0].agent.id);
  assert.equal(tree[1].content, 'hello world');
  assert.equal(tree[1].agent.rootAssistantMessageId, 'root-answer');
});

await run('native message IDs prevent repeated child output after projection restoration', () => {
  const frame = { type: 'assistant', uuid: 'stable', parent_tool_use_id: 'child', message: { id: 'native-message', content: [{ type: 'text', text: 'Kept once' }] } };
  const messages = latest(new NativeAgentProjection('claude', 'session'), [frame]);
  const restored = new NativeAgentProjection('claude', 'session', messages);
  restored.observeClaude(frame, 'root-answer');
  assert.equal(restored.drain()[0].content, 'Kept once');
});

await run('foreground native agents do not release the root turn as background commands', () => {
  const started = recordedClaude.find((frame: Record<string, unknown>) => frame.subtype === 'task_started');
  const task = parseClaudeBackgroundTaskEvent(started)!;
  assert.equal(task.isBackground, false);
  assert.equal(isActiveBackgroundTask(task), false);
  const projection = new NativeAgentProjection('claude', 'session');
  projection.observeClaude({ type: 'system', subtype: 'task_started', task_id: 'bash', task_type: 'local_bash', description: 'Server' }, 'root');
  assert.equal(projection.drain().length, 0);
});

await run('recorded Codex activity creates a native agent and reads bounded child output independently', () => {
  const projection = new NativeAgentProjection('codex', 'session');
  const messages = new Map<string, ConversationMessage>();
  const root = recordedCodex[0].params.threadId;
  let child = '';
  for (const notification of recordedCodex) {
    const result = projection.observeCodex(notification, root, 'root-answer');
    child ||= result.inspect[0] ?? '';
    projection.drain().forEach((message) => messages.set(message.id, message));
  }
  projection.setCodexSnapshot(child, [{ status: 'completed', items: [{ type: 'agentMessage', id: 'child-output', text: 'CHILD_CODEX_OK' }] }]);
  projection.drain().forEach((message) => messages.set(message.id, message));
  assert.equal(messages.size, 1);
  assert.equal([...messages.values()][0].content, 'CHILD_CODEX_OK');
  assert.equal([...messages.values()][0].nativeAgent?.status, 'completed');
  assert.equal(projection.observeCodex({ method: 'turn/completed', params: { threadId: child, turn: { status: 'completed' } } }, root, 'root-answer').child, true);
  assert.equal(projection.observeCodex({ method: 'item/completed', params: { threadId: 'unrelated', item: { type: 'subAgentActivity', id: 'foreign', agentThreadId: 'foreign-child' } } }, root, 'root-answer').inspect.length, 0);
  projection.drain();
  projection.observeCodex({ method: 'item/completed', params: { threadId: root, item: { type: 'collabAgentToolCall', tool: 'sendMessage', id: 'peer-message', receiverThreadIds: ['unrelated-peer', root], agentsStates: {} } } }, root, 'root-answer');
  assert.equal(projection.drain().length, 0, 'Native messaging recipients are not necessarily child agents');
});

await run('restart recovery marks unfinished native status unknown instead of declaring success', () => {
  const messages = latest(new NativeAgentProjection('claude', 'session'), [{ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', id: 'child', input: {} }] } }]);
  const recovered = recoverStaleSessionMessagesForProvider(messages, 'claude');
  assert.equal(recovered[0].nativeAgent?.status, 'unknown');
  assert.equal(recovered[0].status, 'complete');
});

await mkdir('.tmp-tests', { recursive: true });
const root = await mkdtemp(path.resolve('.tmp-tests', 'native-agent-persistence-'));
await Promise.all(['data', 'home', 'workspace'].map((directory) => mkdir(path.join(root, directory))));
await writeFile(path.join(root, 'data', 'easyaiflow-sessions.json'), JSON.stringify({ projects: [], deletedImports: { claudeSessionIds: [], codexThreadIds: [] } }));
configureRuntimePaths({ mode: 'web', userDataPath: path.join(root, 'data'), homePath: path.join(root, 'home') });
await run('the real Claude handler persists child output without touching root text or model', async () => {
  const project = await store.createProject('Native agents', path.join(root, 'workspace'));
  const rootMessage: ConversationMessage = { id: 'root-answer', role: 'assistant', timestamp: '', title: 'Root', content: 'ROOT_ONLY', status: 'streaming' };
  await store.appendMessagesToSession(project.session.id, [rootMessage], 'Root', 'now');
  const state = createClaudeInteractionState();
  const runState = { content: 'ROOT_ONLY', model: 'root-model' };
  const frame = recordedClaude.find((entry: Record<string, unknown>) => entry.type === 'assistant' && entry.parent_tool_use_id);
  await handleClaudeLine({ broadcastEvent: () => undefined } as never, state, project.session.id, 'root-answer', JSON.stringify(frame), runState as never, { child: { killed: false } } as never, () => undefined);
  assert.equal(runState.content, 'ROOT_ONLY');
  assert.equal(runState.model, 'root-model');
  const saved = await store.findSession(project.session.id);
  assert.equal(saved?.messages.find((message) => message.id === 'root-answer')?.content, 'ROOT_ONLY');
  assert.ok(saved?.messages.some((message) => message.nativeAgent && message.content === 'CHILD_NATIVE_OK'));
  await store.flushPendingSave();
});

for (const cancel of [false, true]) {
  await run(cancel ? 'stop addresses the native child turn, not only the finished parent' : 'a finished Codex parent retains its process until native children finish', async () => {
    const project = await store.createProject('Native background', path.join(root, 'workspace'));
    const session = await store.createSession(project.session.id, false, 'codex');
    const handlers = new Set<(event: { method: string; params: Record<string, unknown> }) => void>();
    let closed = false;
    let childDone = false;
    let finishTimer: ReturnType<typeof setTimeout> | undefined;
    let background!: () => void;
    const backgroundSeen = new Promise<void>((resolve) => { background = resolve; });
    const interrupted: string[] = [];
    const emit = (method: string, params: Record<string, unknown>) => handlers.forEach((handler) => handler({ method, params }));
    const fake = {
      threadStart: async () => ({ thread: { id: 'root-thread' } }),
      threadResume: async () => ({ thread: { id: 'root-thread' } }),
      threadSetName: async () => undefined,
      addNotificationHandler: (handler: (event: { method: string; params: Record<string, unknown> }) => void) => handlers.add(handler),
      removeNotificationHandler: (handler: (event: { method: string; params: Record<string, unknown> }) => void) => handlers.delete(handler),
      addExitHandler: () => undefined,
      removeExitHandler: () => undefined,
      close: async () => { closed = true; },
      request: async (method: string) => ({ data: method === 'thread/items/list'
        ? childDone ? [{ turnId: 'child-turn', item: { type: 'agentMessage', id: 'child-reply', text: 'CHILD_NATIVE_OK' } }] : []
        : [{ id: 'child-turn', rootTurnId: 'root-turn', status: childDone ? 'completed' : 'inProgress', items: [] }] }),
      turnInterrupt: async ({ threadId }: { threadId: string }) => { interrupted.push(threadId); },
      turnStart: async () => {
        emit('turn/started', { threadId: 'root-thread', turn: { id: 'root-turn' } });
        emit('item/started', { threadId: 'root-thread', turnId: 'root-turn', item: { type: 'subAgentActivity', id: 'spawn', kind: 'started', agentThreadId: 'child-thread', agentPath: '/root/child' } });
        emit('item/completed', { threadId: 'root-thread', turnId: 'root-turn', item: { type: 'agentMessage', id: 'root-reply', phase: 'final_answer', text: 'ROOT_NATIVE_OK' } });
        emit('turn/completed', { threadId: 'root-thread', turn: { id: 'root-turn', status: 'completed' } });
        return { turn: { id: 'root-turn', status: 'completed' } };
      },
    };
    const original = CodexAppServerClient.create;
    CodexAppServerClient.create = async () => fake as never;
    try {
      const ctx = { broadcastEvent: (event: { type: string; status?: string }) => { if (event.type === 'status' && event.status === 'background') background(); } };
      const running = runCodexAppServerTurn(ctx as never, session.session.id, 'native background');
      await backgroundSeen;
      assert.equal(closed, false);
      if (cancel) await interruptCodexAppServerTurn(ctx as never, session.session.id);
      else finishTimer = setTimeout(() => {
        childDone = true;
        emit('item/completed', { threadId: 'root-thread', turnId: 'root-turn', item: { type: 'subAgentActivity', id: 'finish', kind: 'completed', agentThreadId: 'child-thread', agentPath: '/root/child' } });
      }, 20);
      await running;
      const saved = await store.getSessionRecordForBootstrap(session.session.id);
      const child = saved?.messages.find((message) => message.nativeAgent);
      assert.equal(child?.nativeAgent?.status, cancel ? 'stopped' : 'completed');
      if (cancel) assert.ok(interrupted.includes('child-thread'));
      else assert.equal(child?.content, 'CHILD_NATIVE_OK');
      assert.equal(closed, true);
    } finally { clearTimeout(finishTimer); CodexAppServerClient.create = original; await store.flushPendingSave(); }
  });
}

await run('group mirroring keeps native children attached to their actual room reply', async () => {
  const project = await store.createProject('Native room', path.join(root, 'workspace'));
  const room = await store.createSessionInStreamwork(project.session.dreamId, 'Native room', false, 'claude', 'group');
  assert.ok(room.session.group?.kind === 'room');
  const participant = room.session.group.participants[0];
  const message = latest(new NativeAgentProjection('claude', participant.backingSessionId), recordedClaude)[0];
  const mirrored = createMirroredContext({ broadcastEvent: () => undefined } as never, {
    roomSessionId: room.session.id, backingSessionId: participant.backingSessionId, participant,
    roomAssistantMessageId: 'room-answer', backingAssistantMessageId: 'root-answer',
  });
  mirrored.ctx.broadcastEvent({ type: 'trace', sessionId: participant.backingSessionId, message });
  mirrored.ctx.broadcastEvent({ type: 'trace', sessionId: participant.backingSessionId, message: { ...message, nativeAgent: { ...message.nativeAgent!, rootAssistantMessageId: 'other-turn' }, content: 'Wrong owner' } });
  await mirrored.flush();
  const saved = await store.getSessionRecordForBootstrap(room.session.id);
  const nodes = saved?.messages.filter((entry) => entry.nativeAgent) ?? [];
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].nativeAgent?.rootAssistantMessageId, 'room-answer');
  assert.equal(nodes[0].content, 'CHILD_NATIVE_OK');
  await store.flushPendingSave();
});

await run('native agent paging finds records outside the loaded chat tail without loading the whole conversation', async () => {
  const project = await store.createProject('Agent paging', path.join(root, 'workspace'));
  const created = await store.createSession(project.session.id, false, 'codex');
  const seed = latest(new NativeAgentProjection('claude', created.session.id), recordedClaude)[0];
  const agents = Array.from({ length: 15 }, (_, index): ConversationMessage => ({ ...seed, id: `page-agent-${index}`, nativeAgent: { ...seed.nativeAgent!, id: `page-agent-${index}`, nativeId: `agent-${index}`, revision: 2 } }));
  const traces = Array.from({ length: 150 }, (_, index): ConversationMessage => ({ id: `trace-${index}`, role: 'system', kind: 'progress', timestamp: '', title: 'Progress', content: 'trace', status: 'complete' }));
  await store.appendMessagesToSession(created.session.id, [...agents, ...traces], 'many steps', 'now');
  const memory = await store.getSessionNativeAgents(created.session.id);
  assert.equal(memory.messages.length, 10);
  assert.equal((await store.getSessionNativeAgents(created.session.id, memory.nextBefore)).messages.length, 5);
  await store.releaseMaterializedSessionHistory(created.session.id);
  const tail = await store.getSessionRecordForBootstrap(created.session.id);
  assert.equal(tail?.messages.filter((message) => message.nativeAgent).length, 0);
  const first = await store.getSessionNativeAgents(created.session.id);
  const second = await store.getSessionNativeAgents(created.session.id, first.nextBefore);
  assert.equal(first.messages.length, 10);
  assert.equal(second.messages.length, 5);
  assert.equal(new Set([...first.messages, ...second.messages].map((message) => message.id)).size, 15);
  const stale = { ...agents[0], content: 'old', nativeAgent: { ...agents[0].nativeAgent!, revision: 1 } };
  assert.equal(mergeNativeAgentMessages([agents[0]], [stale])[0].content, agents[0].content);
  await store.flushPendingSave();
});
