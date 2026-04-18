import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
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

const importCodexAppServer = async () =>
  import(pathToFileURL(path.resolve('backend/codexAppServer.ts')).href);

const importFreshCodexAppServerTurn = async () =>
  import(`${pathToFileURL(path.resolve('backend/codexAppServerTurn.ts')).href}?t=${Date.now()}-${Math.random()}`);

const makeTurnState = () => ({
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
  streamedCommentaryTexts: new Map<string, string>(),
  agentMessagePhases: new Map<string, string>(),
  traceItemSnapshots: new Map<string, Record<string, unknown>>(),
  toolProgressMessages: new Map<string, string[]>(),
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
    const state = makeTurnState();
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

await run('handleAppServerNotification ignores item notifications from a different turn on the same client', async () => {
  const tempBase = path.resolve('.tmp-tests');
  await mkdir(tempBase, { recursive: true });
  const tempRoot = await mkdtemp(path.join(tempBase, 'codex-app-server-turn-mismatch-'));
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
    const project = await sessionStore.createProject('Mismatch', workspacePath);
    const sessionId = project.session.id;
    const assistantMessage: ConversationMessage = {
      id: 'assistant-stream-mismatch',
      role: 'assistant',
      timestamp: '2026/4/12 10:00:00',
      title: 'Codex response',
      content: '',
      status: 'streaming',
    };

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
    const state = makeTurnState();

    await codexAppServerTurn.handleAppServerNotification(
      { broadcastEvent: (_event: Record<string, unknown>) => undefined } as never,
      sessionId,
      activeTurn as never,
      state as never,
      () => undefined,
      {
        method: 'item/started',
        params: {
          threadId: 'thread-2',
          turnId: 'turn-2',
          item: {
            id: 'foreign-item',
            type: 'agentMessage',
            text: '',
            phase: 'final_answer',
          },
        },
      },
    );

    await codexAppServerTurn.handleAppServerNotification(
      { broadcastEvent: (_event: Record<string, unknown>) => undefined } as never,
      sessionId,
      activeTurn as never,
      state as never,
      () => undefined,
      {
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'thread-2',
          turnId: 'turn-2',
          itemId: 'foreign-item',
          delta: 'foreign text',
        },
      },
    );

    const session = await sessionStore.findSession(sessionId);
    const streamedAssistant = session?.messages.find(
      (message: ConversationMessage) => message.id === assistantMessage.id,
    );

    assert.equal(streamedAssistant?.content, '');
    assert.equal(state.finalContent, '');
    assert.equal(state.streamedAgentMessageTexts.size, 0);
  } finally {
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }

    await rm(tempRoot, { recursive: true, force: true });
  }
});

await run('handleAppServerNotification ignores turn completion notifications from a different turn on the same client', async () => {
  const codexAppServerTurn = await importFreshCodexAppServerTurn();
  const activeTurn = {
    sessionId: 'session-1',
    assistantMessageId: 'assistant-1',
    threadId: 'thread-1',
    turnId: 'turn-1',
    cwd: 'D:\\AIAgent\\EasyAIFlow-eaf_codex',
    stopped: false,
    completed: false,
    traceMessages: new Map<string, ConversationMessage>(),
  };
  const state = makeTurnState();
  let resolved = false;

  await codexAppServerTurn.handleAppServerNotification(
    { broadcastEvent: (_event: Record<string, unknown>) => undefined } as never,
    'session-1',
    activeTurn as never,
    state as never,
    () => {
      resolved = true;
    },
    {
      method: 'turn/completed',
      params: {
        threadId: 'thread-2',
        turn: {
          id: 'turn-2',
        },
      },
    },
    2,
  );

  assert.equal(state.completed, false);
  assert.equal(resolved, false);
});

await run('handleAppServerNotification ignores unscoped error notifications while multiple turns share the same client', async () => {
  const codexAppServerTurn = await importFreshCodexAppServerTurn();
  const activeTurn = {
    sessionId: 'session-1',
    assistantMessageId: 'assistant-1',
    threadId: 'thread-1',
    turnId: 'turn-1',
    cwd: 'D:\\AIAgent\\EasyAIFlow-eaf_codex',
    stopped: false,
    completed: false,
    traceMessages: new Map<string, ConversationMessage>(),
  };
  const state = makeTurnState();
  let resolved = false;

  await codexAppServerTurn.handleAppServerNotification(
    { broadcastEvent: (_event: Record<string, unknown>) => undefined } as never,
    'session-1',
    activeTurn as never,
    state as never,
    () => {
      resolved = true;
    },
    {
      method: 'error',
      params: {
        error: {
          message: 'Foreign turn failed.',
        },
      },
    },
    2,
  );

  assert.equal(state.error, '');
  assert.equal(state.completed, false);
  assert.equal(resolved, false);
});

await run('handleAppServerNotification still applies unscoped errors when the client has only one active turn', async () => {
  const codexAppServerTurn = await importFreshCodexAppServerTurn();
  const activeTurn = {
    sessionId: 'session-1',
    assistantMessageId: 'assistant-1',
    threadId: 'thread-1',
    turnId: 'turn-1',
    cwd: 'D:\\AIAgent\\EasyAIFlow-eaf_codex',
    stopped: false,
    completed: false,
    traceMessages: new Map<string, ConversationMessage>(),
  };
  const state = makeTurnState();
  let resolved = false;

  await codexAppServerTurn.handleAppServerNotification(
    { broadcastEvent: (_event: Record<string, unknown>) => undefined } as never,
    'session-1',
    activeTurn as never,
    state as never,
    () => {
      resolved = true;
    },
    {
      method: 'error',
      params: {
        error: {
          message: 'Only active turn failed.',
        },
      },
    },
    1,
  );

  assert.equal(state.error, 'Only active turn failed.');
  assert.equal(state.completed, true);
  assert.equal(resolved, true);
});

await run('handleAppServerNotification keeps commentary out of the final assistant message and surfaces tool traces', async () => {
  const tempBase = path.resolve('.tmp-tests');
  await mkdir(tempBase, { recursive: true });
  const tempRoot = await mkdtemp(path.join(tempBase, 'codex-app-server-commentary-'));
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
      id: 'assistant-stream-2',
      role: 'assistant',
      timestamp: '2026/4/12 10:00:00',
      title: 'Codex response',
      content: '',
      status: 'streaming',
    };

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
    const state = makeTurnState();
    const ctx = {
      broadcastEvent: (_event: Record<string, unknown>) => undefined,
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
            id: 'commentary-1',
            type: 'agentMessage',
            text: '先检查',
            phase: 'commentary',
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
          itemId: 'commentary-1',
          delta: ' 代码',
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
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            id: 'commentary-1',
            type: 'agentMessage',
            text: '先检查 代码',
            phase: 'commentary',
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
        method: 'item/started',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            id: 'cmd-1',
            type: 'commandExecution',
            command: 'git status --short',
            aggregatedOutput: '',
            status: 'inProgress',
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
        method: 'item/commandExecution/outputDelta',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'cmd-1',
          delta: ' M src/App.tsx',
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
        method: 'item/started',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            id: 'mcp-1',
            type: 'mcpToolCall',
            tool: 'search_query',
            server: 'web',
            arguments: {
              q: 'EasyAIFlow',
            },
            status: 'inProgress',
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
        method: 'item/mcpToolCall/progress',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'mcp-1',
          message: 'Searching primary sources',
        },
      },
    );

    const session = await sessionStore.findSession(sessionId);
    const updatedAssistant = session?.messages.find((message: ConversationMessage) => message.id === assistantMessage.id);
    const commentaryTrace = session?.messages.find((message: ConversationMessage) => message.id === 'commentary-1');
    const commandTrace = session?.messages.find(
      (message: ConversationMessage) => message.role === 'system' && message.title === 'Command',
    );
    const toolTrace = session?.messages.find(
      (message: ConversationMessage) => message.role === 'system' && message.title === 'search_query',
    );

    assert.equal(updatedAssistant?.content, '');
    assert.equal(commentaryTrace?.role, 'system');
    assert.equal(commentaryTrace?.kind, 'progress');
    assert.equal(commentaryTrace?.content, '先检查 代码');
    assert.equal(commentaryTrace?.status, 'complete');
    assert.match(commandTrace?.content ?? '', /git status --short/);
    assert.match(commandTrace?.content ?? '', /M src\/App\.tsx|M src\\App\.tsx/);
    assert.match(toolTrace?.content ?? '', /Searching primary sources/);
  } finally {
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }

    await rm(tempRoot, { recursive: true, force: true });
  }
});

await run('runCodexAppServerTurn names the native thread after the current session title', async () => {
  const tempBase = path.resolve('.tmp-tests');
  await mkdir(tempBase, { recursive: true });
  const tempRoot = await mkdtemp(path.join(tempBase, 'codex-app-server-title-sync-'));
  const userDataPath = path.join(tempRoot, 'userData');
  const homePath = path.join(tempRoot, 'home');
  const workspacePath = path.join(tempRoot, 'workspace');
  const codexIndexPath = path.join(homePath, '.codex', 'session_index.jsonl');

  await mkdir(userDataPath, { recursive: true });
  await mkdir(homePath, { recursive: true });
  await mkdir(workspacePath, { recursive: true });

  const previousUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = homePath;
  configureRuntimePaths({ mode: 'web', userDataPath, homePath });

  try {
    const sessionStore = await importSessionStore();
    const codexAppServer = await importCodexAppServer();
    const codexAppServerTurn = await importFreshCodexAppServerTurn();
    const project = await sessionStore.createProject('Smoke', workspacePath);
    const created = await sessionStore.createSession(project.session.id, false, 'codex');
    const sessionId = created.session.id;
    const sessionTitle = created.session.title;
    const namedThreads: Array<{ threadId: string; name: string }> = [];
    let createCount = 0;
    let managerAcquireCount = 0;
    let closeCount = 0;
    const fakeClient = {
      threadStart: async () => ({ thread: { id: 'thread-new' } }),
      threadResume: async () => ({ thread: { id: 'thread-new' } }),
      threadSetName: async (threadId: string, name: string) => {
        namedThreads.push({ threadId, name });
      },
      turnStart: async () => ({ turn: { id: 'turn-1', status: 'completed' } }),
      addNotificationHandler: (_handler: (n: { method: string; params: Record<string, unknown> }) => void) => undefined,
      removeNotificationHandler: (_handler: (n: { method: string; params: Record<string, unknown> }) => void) => undefined,
      addExitHandler: (_handler: (error: Error) => void) => undefined,
      removeExitHandler: (_handler: (error: Error) => void) => undefined,
      close: async () => {
        closeCount += 1;
      },
    };
    const originalCreate = codexAppServer.CodexAppServerClient.create;
    const originalAcquire = codexAppServer.appServerManager.acquire;
    const originalRelease = codexAppServer.appServerManager.release;
    codexAppServer.CodexAppServerClient.create = (async (_cwd: string) => {
      createCount += 1;
      return fakeClient as never;
    }) as typeof codexAppServer.CodexAppServerClient.create;
    codexAppServer.appServerManager.acquire = async (_cwd: string) => {
      managerAcquireCount += 1;
      throw new Error('shared app-server should not be used for nonresident turns');
    };
    codexAppServer.appServerManager.release = (_cwd: string) => undefined;

    try {
      const result = await codexAppServerTurn.runCodexAppServerTurn(
        { broadcastEvent: (_event: Record<string, unknown>) => undefined } as never,
        sessionId,
        'Check title sync.',
      );

      const updatedSession = await sessionStore.findSession(sessionId);
      const updatedIndex = JSON.parse((await readFile(codexIndexPath, 'utf8')).trim()) as {
        id?: string;
        thread_name?: string;
      };

      assert.ok(result.queued.assistantMessageId);
      assert.deepEqual(namedThreads, [{ threadId: 'thread-new', name: sessionTitle }]);
      assert.equal(updatedSession?.codexThreadId, 'thread-new');
      assert.equal(createCount, 1);
      assert.equal(managerAcquireCount, 0);
      assert.equal(closeCount, 1);
      assert.equal(updatedIndex.id, 'thread-new');
      assert.equal(updatedIndex.thread_name, sessionTitle);
    } finally {
      codexAppServer.CodexAppServerClient.create = originalCreate;
      codexAppServer.appServerManager.acquire = originalAcquire;
      codexAppServer.appServerManager.release = originalRelease;
    }
  } finally {
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }

    await rm(tempRoot, { recursive: true, force: true });
  }
});

await run('runCodexAppServerTurn finalizes started command traces when the turn completes without an item completion event', async () => {
  const tempBase = path.resolve('.tmp-tests');
  await mkdir(tempBase, { recursive: true });
  const tempRoot = await mkdtemp(path.join(tempBase, 'codex-app-server-finalize-trace-'));
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
    const codexAppServer = await importCodexAppServer();
    const codexAppServerTurn = await importFreshCodexAppServerTurn();
    const project = await sessionStore.createProject('FinalizeTrace', workspacePath);
    const created = await sessionStore.createSession(project.session.id, false, 'codex');
    const sessionId = created.session.id;
    let notificationHandler: ((n: { method: string; params: Record<string, unknown> }) => void) | null = null;
    const fakeClient = {
      threadStart: async () => ({ thread: { id: 'thread-finalize' } }),
      threadResume: async () => ({ thread: { id: 'thread-finalize' } }),
      threadSetName: async (_threadId: string, _name: string) => undefined,
      turnStart: async () => {
        notificationHandler?.({
          method: 'item/started',
          params: {
            threadId: 'thread-finalize',
            turnId: 'turn-finalize',
            item: {
              id: 'cmd-1',
              type: 'commandExecution',
              command: 'git status --short',
              aggregatedOutput: '',
              status: 'inProgress',
            },
          },
        });
        notificationHandler?.({
          method: 'item/commandExecution/outputDelta',
          params: {
            threadId: 'thread-finalize',
            turnId: 'turn-finalize',
            itemId: 'cmd-1',
            delta: ' M src/App.tsx',
          },
        });
        notificationHandler?.({
          method: 'item/started',
          params: {
            threadId: 'thread-finalize',
            turnId: 'turn-finalize',
            item: {
              id: 'answer-1',
              type: 'agentMessage',
              text: 'Checking status.',
              phase: 'final_answer',
            },
          },
        });
        notificationHandler?.({
          method: 'item/completed',
          params: {
            threadId: 'thread-finalize',
            turnId: 'turn-finalize',
            item: {
              id: 'answer-1',
              type: 'agentMessage',
              text: 'Checking status.',
              phase: 'final_answer',
            },
          },
        });
        return { turn: { id: 'turn-finalize', status: 'completed' } };
      },
      addNotificationHandler: (handler: (n: { method: string; params: Record<string, unknown> }) => void) => {
        notificationHandler = handler;
      },
      removeNotificationHandler: (_handler: (n: { method: string; params: Record<string, unknown> }) => void) => {
        notificationHandler = null;
      },
      addExitHandler: (_handler: (error: Error) => void) => undefined,
      removeExitHandler: (_handler: (error: Error) => void) => undefined,
      close: async () => undefined,
    };
    const originalCreate = codexAppServer.CodexAppServerClient.create;
    codexAppServer.CodexAppServerClient.create = (async (_cwd: string) => fakeClient as never) as typeof codexAppServer.CodexAppServerClient.create;

    try {
      await codexAppServerTurn.runCodexAppServerTurn(
        { broadcastEvent: (_event: Record<string, unknown>) => undefined } as never,
        sessionId,
        'Finish the turn.',
      );

      const updatedSession = await sessionStore.findSession(sessionId);
      const commandTrace = updatedSession?.messages.find(
        (message: ConversationMessage) => message.kind === 'tool_use' && message.title === 'Command',
      );

      assert.equal(commandTrace?.status, 'success');
      assert.match(commandTrace?.content ?? '', /git status --short/);
      assert.match(commandTrace?.content ?? '', /M src\/App\.tsx/);
    } finally {
      codexAppServer.CodexAppServerClient.create = originalCreate;
    }
  } finally {
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }

    await rm(tempRoot, { recursive: true, force: true });
  }
});

await run('runResidentCodexAppServerTurn keeps the Codex app-server session online after the turn completes', async () => {
  const tempBase = path.resolve('.tmp-tests');
  await mkdir(tempBase, { recursive: true });
  const tempRoot = await mkdtemp(path.join(tempBase, 'codex-app-server-resident-'));
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
    const codexAppServer = await importCodexAppServer();
    const codexAppServerTurn = await importFreshCodexAppServerTurn();
    const project = await sessionStore.createProject('Resident', workspacePath);
    const created = await sessionStore.createSession(project.session.id, false, 'codex');
    const sessionId = created.session.id;
    const runtimeEvents: Array<Record<string, unknown>> = [];
    let releaseCount = 0;
    const fakeClient = {
      threadStart: async () => ({ thread: { id: 'thread-resident' } }),
      threadResume: async () => ({ thread: { id: 'thread-resident' } }),
      threadSetName: async (_threadId: string, _name: string) => undefined,
      turnStart: async () => ({ turn: { id: 'turn-1', status: 'completed' } }),
      addNotificationHandler: (_handler: (n: { method: string; params: Record<string, unknown> }) => void) => undefined,
      removeNotificationHandler: (_handler: (n: { method: string; params: Record<string, unknown> }) => void) => undefined,
      addExitHandler: (_handler: (error: Error) => void) => undefined,
      removeExitHandler: (_handler: (error: Error) => undefined) => undefined,
    };
    const originalAcquire = codexAppServer.appServerManager.acquire;
    const originalRelease = codexAppServer.appServerManager.release;
    codexAppServer.appServerManager.acquire = async (_cwd: string) => fakeClient as never;
    codexAppServer.appServerManager.release = (_cwd: string) => {
      releaseCount += 1;
    };

    try {
      const result = await codexAppServerTurn.runResidentCodexAppServerTurn(
        {
          broadcastEvent: (event: Record<string, unknown>) => {
            runtimeEvents.push(event);
          },
        } as never,
        sessionId,
        'Stay online after this turn.',
      );

      const updatedSession = await sessionStore.findSession(sessionId);
      const snapshots = codexAppServerTurn.getCodexAppServerInteractionSnapshots();
      const runtime = snapshots[sessionId]?.runtime;

      assert.ok(result.queued.assistantMessageId);
      assert.equal(updatedSession?.codexThreadId, 'thread-resident');
      assert.equal(runtime?.processActive, true);
      assert.equal(runtime?.phase, 'idle');
      assert.equal(releaseCount, 0);
      assert.equal(
        runtimeEvents.some(
          (event) =>
            event.type === 'runtime-state' &&
            event.sessionId === sessionId &&
            (event as { runtime?: { phase?: string } }).runtime?.phase === 'idle',
        ),
        true,
      );
    } finally {
      codexAppServer.appServerManager.acquire = originalAcquire;
      codexAppServer.appServerManager.release = originalRelease;
    }
  } finally {
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }

    await rm(tempRoot, { recursive: true, force: true });
  }
});

await run('disconnectCodexAppServerTurn releases the resident Codex app-server session', async () => {
  const tempBase = path.resolve('.tmp-tests');
  await mkdir(tempBase, { recursive: true });
  const tempRoot = await mkdtemp(path.join(tempBase, 'codex-app-server-resident-disconnect-'));
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
    const codexAppServer = await importCodexAppServer();
    const codexAppServerTurn = await importFreshCodexAppServerTurn();
    const project = await sessionStore.createProject('ResidentDisconnect', workspacePath);
    const created = await sessionStore.createSession(project.session.id, false, 'codex');
    const sessionId = created.session.id;
    let releaseCount = 0;
    let removeExitHandlerCount = 0;
    const fakeClient = {
      threadStart: async () => ({ thread: { id: 'thread-resident' } }),
      threadResume: async () => ({ thread: { id: 'thread-resident' } }),
      threadSetName: async (_threadId: string, _name: string) => undefined,
      turnStart: async () => ({ turn: { id: 'turn-1', status: 'completed' } }),
      addNotificationHandler: (_handler: (n: { method: string; params: Record<string, unknown> }) => void) => undefined,
      removeNotificationHandler: (_handler: (n: { method: string; params: Record<string, unknown> }) => void) => undefined,
      addExitHandler: (_handler: (error: Error) => void) => undefined,
      removeExitHandler: (_handler: (error: Error) => void) => {
        removeExitHandlerCount += 1;
      },
    };
    const originalAcquire = codexAppServer.appServerManager.acquire;
    const originalRelease = codexAppServer.appServerManager.release;
    codexAppServer.appServerManager.acquire = async (_cwd: string) => fakeClient as never;
    codexAppServer.appServerManager.release = (_cwd: string) => {
      releaseCount += 1;
    };

    try {
      await codexAppServerTurn.runResidentCodexAppServerTurn(
        { broadcastEvent: (_event: Record<string, unknown>) => undefined } as never,
        sessionId,
        'Connect and then disconnect.',
      );

      await codexAppServerTurn.disconnectCodexAppServerTurn(
        { broadcastEvent: (_event: Record<string, unknown>) => undefined } as never,
        sessionId,
      );

      const snapshots = codexAppServerTurn.getCodexAppServerInteractionSnapshots();
      assert.equal(snapshots[sessionId], undefined);
      assert.equal(releaseCount, 1);
      assert.equal(removeExitHandlerCount, 2);
    } finally {
      codexAppServer.appServerManager.acquire = originalAcquire;
      codexAppServer.appServerManager.release = originalRelease;
    }
  } finally {
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }

    await rm(tempRoot, { recursive: true, force: true });
  }
});

await run('runCodexAppServerTurn uses a dedicated client for nonresident turns on the same cwd', async () => {
  const tempBase = path.resolve('.tmp-tests');
  await mkdir(tempBase, { recursive: true });
  const tempRoot = await mkdtemp(path.join(tempBase, 'codex-app-server-dedicated-'));
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
    const codexAppServer = await importCodexAppServer();
    const codexAppServerTurn = await importFreshCodexAppServerTurn();
    const project = await sessionStore.createProject('Dedicated', workspacePath);
    const created = await sessionStore.createSession(project.session.id, false, 'codex');
    const sessionId = created.session.id;
    let notificationHandler: ((n: { method: string; params: Record<string, unknown> }) => void) | null = null;
    let createCount = 0;
    let managerAcquireCount = 0;
    let closeCount = 0;
    const fakeClient = {
      threadStart: async () => ({ thread: { id: 'thread-dedicated' } }),
      threadResume: async () => ({ thread: { id: 'thread-dedicated' } }),
      threadSetName: async (_threadId: string, _name: string) => undefined,
      turnStart: async () => {
        notificationHandler?.({
          method: 'item/started',
          params: {
            threadId: 'thread-dedicated',
            turnId: 'turn-dedicated',
            item: {
              id: 'answer-dedicated',
              type: 'agentMessage',
              text: 'Dedicated response.',
              phase: 'final_answer',
            },
          },
        });
        notificationHandler?.({
          method: 'item/completed',
          params: {
            threadId: 'thread-dedicated',
            turnId: 'turn-dedicated',
            item: {
              id: 'answer-dedicated',
              type: 'agentMessage',
              text: 'Dedicated response.',
              phase: 'final_answer',
            },
          },
        });
        return { turn: { id: 'turn-dedicated', status: 'completed' } };
      },
      addNotificationHandler: (handler: (n: { method: string; params: Record<string, unknown> }) => void) => {
        notificationHandler = handler;
      },
      removeNotificationHandler: (_handler: (n: { method: string; params: Record<string, unknown> }) => void) => {
        notificationHandler = null;
      },
      addExitHandler: (_handler: (error: Error) => void) => undefined,
      removeExitHandler: (_handler: (error: Error) => void) => undefined,
      close: async () => {
        closeCount += 1;
      },
    };
    const originalCreate = codexAppServer.CodexAppServerClient.create;
    const originalAcquire = codexAppServer.appServerManager.acquire;
    const originalRelease = codexAppServer.appServerManager.release;
    codexAppServer.CodexAppServerClient.create = (async (_cwd: string) => {
      createCount += 1;
      return fakeClient as never;
    }) as typeof codexAppServer.CodexAppServerClient.create;
    codexAppServer.appServerManager.acquire = async (_cwd: string) => {
      managerAcquireCount += 1;
      throw new Error('shared app-server should not be used for nonresident turns');
    };
    codexAppServer.appServerManager.release = (_cwd: string) => undefined;

    try {
      await codexAppServerTurn.runCodexAppServerTurn(
        { broadcastEvent: (_event: Record<string, unknown>) => undefined } as never,
        sessionId,
        'Use an isolated client.',
      );

      const updatedSession = await sessionStore.findSession(sessionId);
      const assistant = updatedSession?.messages.find(
        (message: ConversationMessage) => message.role === 'assistant',
      );

      assert.equal(createCount, 1);
      assert.equal(managerAcquireCount, 0);
      assert.equal(closeCount, 1);
      assert.equal(assistant?.status, 'complete');
      assert.equal(assistant?.content, 'Dedicated response.');
    } finally {
      codexAppServer.CodexAppServerClient.create = originalCreate;
      codexAppServer.appServerManager.acquire = originalAcquire;
      codexAppServer.appServerManager.release = originalRelease;
    }
  } finally {
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }

    await rm(tempRoot, { recursive: true, force: true });
  }
});

await run('appServerManager.acquire coalesces concurrent first access for the same cwd', async () => {
  const codexAppServer = await importCodexAppServer();
  await codexAppServer.appServerManager.closeAll();

  const originalCreate = codexAppServer.CodexAppServerClient.create;
  const workspacePath = `D:\\AIAgent\\EasyAIFlow-eaf_codex\\.tmp-tests\\coalesced-${Date.now()}`;
  let createCount = 0;
  let closeCount = 0;
  const fakeClient = {
    close: async () => {
      closeCount += 1;
    },
  };

  codexAppServer.CodexAppServerClient.create = (async (_cwd: string) => {
    createCount += 1;
    await sleep(20);
    return fakeClient as never;
  }) as typeof codexAppServer.CodexAppServerClient.create;

  try {
    const [left, right] = await Promise.all([
      codexAppServer.appServerManager.acquire(workspacePath),
      codexAppServer.appServerManager.acquire(workspacePath),
    ]);

    assert.equal(left, right);
    assert.equal(createCount, 1);

    codexAppServer.appServerManager.release(workspacePath);
    codexAppServer.appServerManager.release(workspacePath);
    await sleep(0);

    assert.equal(closeCount, 1);
  } finally {
    codexAppServer.CodexAppServerClient.create = originalCreate;
    await codexAppServer.appServerManager.closeAll();
  }
});
