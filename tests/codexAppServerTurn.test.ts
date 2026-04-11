import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { configureRuntimePaths } from '../backend/runtimePaths.ts';
import type { ConversationMessage } from '../src/data/types.ts';

const run = async (name: string, fn: () => Promise<void>) => {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

const importSessionStore = async () =>
  import(pathToFileURL(path.resolve('electron/sessionStore.ts')).href);

const importFreshCodexAppServerTurn = async () =>
  import(`${pathToFileURL(path.resolve('backend/codexAppServerTurn.ts')).href}?t=${Date.now()}-${Math.random()}`);

await run('handleAppServerNotification streams Codex agent message deltas into the assistant message', async () => {
  const tempBase = path.resolve('.tmp-tests');
  await mkdir(tempBase, { recursive: true });
  const tempRoot = await mkdtemp(path.join(tempBase, 'codex-app-server-turn-'));
  const userDataPath = path.join(tempRoot, 'userData');
  const homePath = path.join(tempRoot, 'home');
  const workspacePath = path.join(tempRoot, 'workspace');

  await mkdir(userDataPath, { recursive: true });
  await mkdir(homePath, { recursive: true });
  await mkdir(workspacePath, { recursive: true });

  const previousUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = homePath;
  configureRuntimePaths({ mode: 'web', userDataPath, homePath });

  try {
    const sessionStore = await importSessionStore();
    const codexAppServerTurn = await importFreshCodexAppServerTurn();
    const project = await sessionStore.createProject('Smoke', workspacePath);
    const sessionId = project.session.id;
    const assistantMessage: ConversationMessage = {
      id: 'assistant-stream-1',
      role: 'assistant',
      timestamp: '2026/4/12 10:00:00',
      title: 'Codex response',
      content: '',
      status: 'streaming',
    };
    const events: Array<Record<string, unknown>> = [];

    await sessionStore.appendMessagesToSession(sessionId, [assistantMessage], 'Preview', 'Just now');

    const activeTurn = {
      sessionId,
      assistantMessageId: assistantMessage.id,
      threadId: 'thread-1',
      turnId: 'turn-1',
      cwd: workspacePath,
      stopped: false,
      completed: false,
      traceMessages: new Map<string, ConversationMessage>(),
    };
    const state = {
      turnId: 'turn-1',
      finalContent: '',
      tokenUsage: undefined,
      error: '',
      completed: false,
      finalAnswerSeen: false,
      completionTimer: null,
      traceMessages: new Map<string, ConversationMessage>(),
      streamedAgentMessageOrder: [] as string[],
      streamedAgentMessageTexts: new Map<string, string>(),
    };
    const ctx = {
      broadcastEvent: (event: Record<string, unknown>) => {
        events.push(event);
      },
    };

    await codexAppServerTurn.handleAppServerNotification(
      ctx as never,
      sessionId,
      activeTurn as never,
      state as never,
      () => undefined,
      {
        method: 'item/started',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            id: 'item-1',
            type: 'agentMessage',
            text: '',
            phase: 'final_answer',
          },
        },
      },
    );

    await codexAppServerTurn.handleAppServerNotification(
      ctx as never,
      sessionId,
      activeTurn as never,
      state as never,
      () => undefined,
      {
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-1',
          delta: 'hello',
        },
      },
    );

    let session = await sessionStore.findSession(sessionId);
    let streamedAssistant = session?.messages.find((message: ConversationMessage) => message.id === assistantMessage.id);
    assert.equal(streamedAssistant?.content, 'hello');
    assert.equal(streamedAssistant?.status, 'streaming');
    assert.equal(events.at(-1)?.type, 'status');
    assert.equal(events.at(-1)?.content, 'hello');

    await codexAppServerTurn.handleAppServerNotification(
      ctx as never,
      sessionId,
      activeTurn as never,
      state as never,
      () => undefined,
      {
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-1',
          delta: ' world',
        },
      },
    );

    session = await sessionStore.findSession(sessionId);
    streamedAssistant = session?.messages.find((message: ConversationMessage) => message.id === assistantMessage.id);
    assert.equal(streamedAssistant?.content, 'hello world');
    assert.equal(events.at(-1)?.content, 'hello world');

    await codexAppServerTurn.handleAppServerNotification(
      ctx as never,
      sessionId,
      activeTurn as never,
      state as never,
      () => undefined,
      {
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            id: 'item-1',
            type: 'agentMessage',
            text: 'hello world',
            phase: 'final_answer',
          },
        },
      },
    );

    assert.equal(state.finalContent, 'hello world');
    assert.equal(state.finalAnswerSeen, true);
  } finally {
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }

    await rm(tempRoot, { recursive: true, force: true });
  }
});
