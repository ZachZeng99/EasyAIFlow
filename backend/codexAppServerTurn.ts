import { randomUUID } from 'node:crypto';
import type { ClaudeInteractionContext } from './claudeInteractionContext.js';
import { buildMessageTitle, nowLabel } from './claudeHelpers.js';
import {
  prepareCodexRun,
  emitRuntimeState,
  emitTraceMessage,
  toCodexTokenUsage,
  buildCodexCommandTraceMessage,
  buildCodexFunctionCallTraceMessage,
} from './codexInteraction.js';
import {
  findSession,
  getProjects,
  renameNativeCodexThread,
  setSessionRuntime,
  updateAssistantMessage,
} from '../electron/sessionStore.js';
import { stopPendingSessionMessages } from '../electron/sessionStop.js';
import { appServerManager, type CodexAppServerClient } from './codexAppServer.js';
import type { SessionInteractionState } from '../src/data/sessionInteraction.js';
import type {
  ConversationMessage,
  ContextReference,
  PendingAttachment,
  SessionRuntimePhase,
  SessionSummary,
  TokenUsage,
} from '../src/data/types.js';

export type CodexAppServerTurnOptions = {
  model?: string;
  references?: ContextReference[];
  outputSchema?: object;
  parseFinalMessage?: (raw: string) => string;
};

type ActiveAppServerTurn = {
  sessionId: string;
  assistantMessageId: string;
  threadId: string;
  turnId: string | null;
  cwd: string;
  stopped: boolean;
  completed: boolean;
  disconnectOnFinish: boolean;
  traceMessages: Map<string, ConversationMessage>;
  settle?: () => void;
};

const activeAppServerTurns = new Map<string, ActiveAppServerTurn>();

type ResidentAppServerSession = {
  sessionId: string;
  cwd: string;
  client: CodexAppServerClient;
  threadId: string;
  exitHandler: (error: Error) => void;
};

const residentAppServerSessions = new Map<string, ResidentAppServerSession>();

type TurnCaptureState = {
  turnId: string | null;
  finalContent: string;
  tokenUsage: TokenUsage | undefined;
  error: string;
  completed: boolean;
  finalAnswerSeen: boolean;
  completionTimer: ReturnType<typeof setTimeout> | null;
  traceMessages: Map<string, ConversationMessage>;
  streamedAgentMessageOrder: string[];
  streamedAgentMessageTexts: Map<string, string>;
  streamedCommentaryTexts: Map<string, string>;
  agentMessagePhases: Map<string, string>;
  traceItemSnapshots: Map<string, Record<string, unknown>>;
  toolProgressMessages: Map<string, string[]>;
};

const clearCompletionTimer = (state: TurnCaptureState) => {
  if (state.completionTimer) {
    clearTimeout(state.completionTimer);
    state.completionTimer = null;
  }
};

const scheduleInferredCompletion = (
  state: TurnCaptureState,
  resolve: (state: TurnCaptureState) => void,
) => {
  if (state.completed || !state.finalAnswerSeen) return;
  clearCompletionTimer(state);
  state.completionTimer = setTimeout(() => {
    state.completionTimer = null;
    if (!state.completed && state.finalAnswerSeen) {
      state.completed = true;
      resolve(state);
    }
  }, 250);
};

const ensureStreamedAgentMessageSlot = (state: TurnCaptureState, itemId: string) => {
  if (state.streamedAgentMessageTexts.has(itemId)) {
    return;
  }

  state.streamedAgentMessageOrder.push(itemId);
  state.streamedAgentMessageTexts.set(itemId, '');
};

const getStreamedAgentMessageContent = (state: TurnCaptureState) =>
  state.streamedAgentMessageOrder
    .map((itemId) => state.streamedAgentMessageTexts.get(itemId) ?? '')
    .filter((text) => text.length > 0)
    .join('\n\n');

const getTraceItemId = (item: Record<string, unknown>) => {
  if (typeof item.call_id === 'string' && item.call_id.trim()) {
    return item.call_id;
  }

  if (typeof item.id === 'string' && item.id.trim()) {
    return item.id;
  }

  return '';
};

const getCommentaryStatus = (lifecycle: 'started' | 'completed') =>
  lifecycle === 'completed' ? 'complete' : 'running';

const getCommandTraceStatus = (item: Record<string, unknown>, lifecycle: 'started' | 'completed') => {
  if (lifecycle === 'started') {
    return 'running' as const;
  }

  const itemStatus = typeof item.status === 'string' ? item.status : '';
  const exitCode =
    typeof item.exitCode === 'number'
      ? item.exitCode
      : typeof item.exit_code === 'number'
        ? item.exit_code
        : null;

  return itemStatus === 'failed' || itemStatus === 'declined' || (exitCode !== null && exitCode !== 0)
    ? 'error'
    : 'success';
};

const getFunctionTraceStatus = (item: Record<string, unknown>, lifecycle: 'started' | 'completed') => {
  if (lifecycle === 'started') {
    return 'running' as const;
  }

  const itemStatus = typeof item.status === 'string' ? item.status : '';
  return itemStatus === 'failed' || Boolean(item.error) ? 'error' : 'success';
};

const upsertTraceItemSnapshot = (
  state: TurnCaptureState,
  itemId: string,
  item: Record<string, unknown>,
) => {
  const next = {
    ...(state.traceItemSnapshots.get(itemId) ?? {}),
    ...item,
  };
  state.traceItemSnapshots.set(itemId, next);
  return next;
};

const appendToolProgressMessage = (
  state: TurnCaptureState,
  itemId: string,
  message: string,
) => {
  const trimmed = message.trim();
  if (!trimmed) {
    return;
  }

  const next = [...(state.toolProgressMessages.get(itemId) ?? [])];
  if (next[next.length - 1] === trimmed) {
    return;
  }
  next.push(trimmed);
  state.toolProgressMessages.set(itemId, next);
};

const getNotificationThreadId = (params: Record<string, unknown>) => {
  if (typeof params.threadId === 'string' && params.threadId.trim()) {
    return params.threadId.trim();
  }

  const thread = params.thread as { id?: unknown } | undefined;
  return typeof thread?.id === 'string' && thread.id.trim() ? thread.id.trim() : '';
};

const getNotificationTurnId = (params: Record<string, unknown>) => {
  if (typeof params.turnId === 'string' && params.turnId.trim()) {
    return params.turnId.trim();
  }

  const turn = params.turn as { id?: unknown } | undefined;
  return typeof turn?.id === 'string' && turn.id.trim() ? turn.id.trim() : '';
};

const countActiveAppServerTurnsForCwd = (cwd: string) => {
  let count = 0;
  for (const turn of activeAppServerTurns.values()) {
    if (turn.cwd !== cwd || turn.stopped || turn.completed) {
      continue;
    }
    count += 1;
  }
  return count;
};

const getResidentRuntimePhase = (sessionId: string): SessionRuntimePhase =>
  activeAppServerTurns.has(sessionId) ? 'running' : 'idle';

const emitResidentRuntimeState = (ctx: ClaudeInteractionContext, sessionId: string) =>
  emitRuntimeState(ctx, sessionId, getResidentRuntimePhase(sessionId), true);

const getResidentAppServerSession = (sessionId: string) => residentAppServerSessions.get(sessionId);

const cleanupResidentAppServerSession = (sessionId: string) => {
  residentAppServerSessions.delete(sessionId);
};

const resolveResidentSession = async (
  sessionId: string,
  fallbackSession?: SessionSummary,
) => {
  const session = (await findSession(sessionId)) ?? fallbackSession;
  if (!session) {
    throw new Error('Session not found.');
  }
  return session;
};

const connectResidentCodexSession = async (
  ctx: ClaudeInteractionContext,
  sessionId: string,
  fallbackSession?: SessionSummary,
) => {
  const existing = getResidentAppServerSession(sessionId);
  if (existing) {
    return existing;
  }

  const session = await resolveResidentSession(sessionId, fallbackSession);
  const client = await appServerManager.acquire(session.workspace);
  const resident: ResidentAppServerSession = {
    sessionId,
    cwd: session.workspace,
    client,
    threadId: session.codexThreadId?.trim() || '',
    exitHandler: (error: Error) => {
      const current = getResidentAppServerSession(sessionId);
      if (current !== resident) {
        return;
      }

      cleanupResidentAppServerSession(sessionId);
      activeAppServerTurns.delete(sessionId);
      console.warn('[CODEX] Resident app-server session exited', sessionId, error.message);
      emitRuntimeState(ctx, sessionId, 'inactive', false);
    },
  };

  client.addExitHandler(resident.exitHandler);
  residentAppServerSessions.set(sessionId, resident);
  emitResidentRuntimeState(ctx, sessionId);
  return resident;
};

const disconnectResidentCodexSessionInternal = async (
  ctx: ClaudeInteractionContext,
  sessionId: string,
  emitInactive = true,
) => {
  const resident = getResidentAppServerSession(sessionId);
  if (!resident) {
    if (emitInactive) {
      emitRuntimeState(ctx, sessionId, 'inactive', false);
    }
    return;
  }

  cleanupResidentAppServerSession(sessionId);
  resident.client.removeExitHandler(resident.exitHandler);
  appServerManager.release(resident.cwd);
  if (emitInactive) {
    emitRuntimeState(ctx, sessionId, 'inactive', false);
  }
};

const notificationHasExplicitScope = (params: Record<string, unknown>) =>
  Boolean(getNotificationThreadId(params) || getNotificationTurnId(params));

const matchesActiveTurnScope = (
  activeTurn: ActiveAppServerTurn,
  state: TurnCaptureState,
  params: Record<string, unknown>,
) => {
  const notificationThreadId = getNotificationThreadId(params);
  const notificationTurnId = getNotificationTurnId(params);
  const activeThreadId = activeTurn.threadId.trim();
  const knownTurnId = (state.turnId ?? activeTurn.turnId ?? '').trim();

  if (notificationThreadId && activeThreadId && notificationThreadId !== activeThreadId) {
    return false;
  }

  if (notificationTurnId && knownTurnId && notificationTurnId !== knownTurnId) {
    return false;
  }

  if (
    notificationTurnId &&
    !knownTurnId &&
    (!notificationThreadId || !activeThreadId || notificationThreadId === activeThreadId)
  ) {
    state.turnId = notificationTurnId;
    activeTurn.turnId = notificationTurnId;
  }

  return true;
};

const matchesHandledNotificationScope = (
  activeTurn: ActiveAppServerTurn,
  state: TurnCaptureState,
  params: Record<string, unknown>,
  activeTurnCountForCwd: number,
) => {
  if (!notificationHasExplicitScope(params)) {
    // Shared app-server notifications without thread/turn IDs are ambiguous
    // once multiple turns are active on the same client. Drop them rather than
    // letting one turn's failure/completion leak into another session.
    return activeTurnCountForCwd <= 1;
  }

  return matchesActiveTurnScope(activeTurn, state, params);
};

const syncCodexThreadTitle = async (
  client: Pick<CodexAppServerClient, 'threadSetName'>,
  threadId: string,
  title: string,
) => {
  const normalizedThreadId = threadId.trim();
  const normalizedTitle = title.trim();
  if (!normalizedThreadId || !normalizedTitle) {
    return;
  }

  await Promise.allSettled([
    client.threadSetName(normalizedThreadId, normalizedTitle),
    renameNativeCodexThread(normalizedThreadId, normalizedTitle),
  ]);
};

const syncStreamingAssistantMessage = async (
  ctx: ClaudeInteractionContext,
  sessionId: string,
  assistantMessageId: string,
  content: string,
) => {
  const title = buildMessageTitle(content, 'Codex response');
  await updateAssistantMessage(sessionId, assistantMessageId, (message) => {
    message.title = title;
    message.content = content;
    message.status = 'streaming';
  });
  ctx.broadcastEvent({
    type: 'status',
    sessionId,
    messageId: assistantMessageId,
    status: 'streaming',
    title,
    content,
  });
};

const syncCommentaryTraceMessage = async (
  ctx: ClaudeInteractionContext,
  sessionId: string,
  state: TurnCaptureState,
  itemId: string,
  status: ConversationMessage['status'],
) => {
  const content = (state.streamedCommentaryTexts.get(itemId) ?? '').trim();
  const previous = state.traceMessages.get(itemId);
  if (!content && !previous) {
    return;
  }

  const trace: ConversationMessage = {
    id: previous?.id ?? itemId,
    role: 'system',
    kind: 'progress',
    timestamp: previous?.timestamp ?? nowLabel(),
    title: 'Commentary',
    content: content || previous?.content || '',
    status,
  };
  state.traceMessages.set(itemId, trace);
  await emitTraceMessage(ctx, sessionId, trace);
};

const syncCommandTraceMessage = async (
  ctx: ClaudeInteractionContext,
  sessionId: string,
  state: TurnCaptureState,
  itemId: string,
  item: Record<string, unknown>,
  lifecycle: 'started' | 'completed',
) => {
  const snapshot = upsertTraceItemSnapshot(state, itemId, item);
  const trace = buildCodexCommandTraceMessage({
    item: snapshot as Parameters<typeof buildCodexCommandTraceMessage>[0]['item'],
    status: getCommandTraceStatus(snapshot, lifecycle),
    previous: state.traceMessages.get(itemId),
  });
  if (!trace) {
    return;
  }

  state.traceMessages.set(itemId, trace);
  await emitTraceMessage(ctx, sessionId, trace);
};

const syncFunctionTraceMessage = async (
  ctx: ClaudeInteractionContext,
  sessionId: string,
  state: TurnCaptureState,
  itemId: string,
  item: Record<string, unknown>,
  lifecycle: 'started' | 'completed',
) => {
  const snapshot = upsertTraceItemSnapshot(state, itemId, item);
  const trace = buildCodexFunctionCallTraceMessage({
    item: snapshot as Parameters<typeof buildCodexFunctionCallTraceMessage>[0]['item'],
    status: getFunctionTraceStatus(snapshot, lifecycle),
    previous: state.traceMessages.get(itemId),
    title:
      typeof snapshot.name === 'string'
        ? snapshot.name
        : typeof snapshot.tool === 'string'
          ? snapshot.tool
          : undefined,
    extraLines: state.toolProgressMessages.get(itemId),
  });
  if (!trace) {
    return;
  }

  state.traceMessages.set(itemId, trace);
  await emitTraceMessage(ctx, sessionId, trace);
};

export const handleAppServerNotification = async (
  ctx: ClaudeInteractionContext,
  sessionId: string,
  activeTurn: ActiveAppServerTurn,
  state: TurnCaptureState,
  resolve: (state: TurnCaptureState) => void,
  notification: { method: string; params: Record<string, unknown> },
  activeTurnCountForCwd = 1,
) => {
  const { method, params } = notification;

  if (method === 'turn/started') {
    if (!matchesHandledNotificationScope(activeTurn, state, params, activeTurnCountForCwd)) {
      return;
    }

    const turn = params.turn as { id?: string } | undefined;
    if (turn?.id) {
      if (!state.turnId) {
        state.turnId = turn.id;
        activeTurn.turnId = turn.id;
      }
    }
    return;
  }

  if (method === 'turn/completed') {
    if (!matchesHandledNotificationScope(activeTurn, state, params, activeTurnCountForCwd)) {
      return;
    }
    state.completed = true;
    clearCompletionTimer(state);
    resolve(state);
    return;
  }

  if (method === 'error') {
    if (!matchesHandledNotificationScope(activeTurn, state, params, activeTurnCountForCwd)) {
      return;
    }

    const error = params.error as { message?: string } | undefined;
    state.error = error?.message ?? 'Codex app-server error';
    state.completed = true;
    clearCompletionTimer(state);
    resolve(state);
    return;
  }

  if (method === 'item/started' || method === 'item/completed') {
    if (!matchesHandledNotificationScope(activeTurn, state, params, activeTurnCountForCwd)) {
      return;
    }

    const item = params.item as Record<string, unknown> | undefined;
    if (!item) return;

    const itemType = typeof item.type === 'string' ? item.type : '';
    const lifecycle = method === 'item/started' ? 'started' : 'completed';

    if (itemType === 'commandExecution') {
      const itemId = getTraceItemId(item);
      if (itemId) {
        await syncCommandTraceMessage(ctx, sessionId, state, itemId, item, lifecycle);
      }
      return;
    }

    if (
      itemType === 'mcpToolCall' ||
      itemType === 'dynamicToolCall' ||
      itemType === 'collabAgentToolCall' ||
      itemType === 'function_call' ||
      itemType === 'function_call_output'
    ) {
      const itemId = getTraceItemId(item);
      if (itemId) {
        await syncFunctionTraceMessage(ctx, sessionId, state, itemId, item, lifecycle);
      }
      return;
    }

    if (itemType === 'agentMessage') {
      const itemId = typeof item.id === 'string' ? item.id : '';
      const text = typeof item.text === 'string' ? item.text : '';
      const phase = typeof item.phase === 'string' ? item.phase : '';
      if (itemId) {
        state.agentMessagePhases.set(itemId, phase);
      }

      if (itemId && phase === 'commentary') {
        if (text) {
          state.streamedCommentaryTexts.set(itemId, text);
        }
        await syncCommentaryTraceMessage(
          ctx,
          sessionId,
          state,
          itemId,
          getCommentaryStatus(lifecycle),
        );
        return;
      }

      if (itemId) {
        ensureStreamedAgentMessageSlot(state, itemId);
      }

      if (text && itemId) {
        state.streamedAgentMessageTexts.set(itemId, text);
        await syncStreamingAssistantMessage(
          ctx,
          sessionId,
          activeTurn.assistantMessageId,
          getStreamedAgentMessageContent(state),
        );
      }

      if (lifecycle === 'completed') {
        if (text) {
          state.finalContent = state.finalContent
            ? `${state.finalContent}\n\n${text}`
            : text;
        }
        if (phase === 'final_answer') {
          state.finalAnswerSeen = true;
          scheduleInferredCompletion(state, resolve);
        }
      }
      return;
    }
  }

  if (method === 'item/agentMessage/delta') {
    if (!matchesHandledNotificationScope(activeTurn, state, params, activeTurnCountForCwd)) {
      return;
    }

    const itemId = typeof params.itemId === 'string' ? params.itemId : '';
    const delta = typeof params.delta === 'string' ? params.delta : '';
    if (!itemId || !delta) {
      return;
    }

    if (state.agentMessagePhases.get(itemId) === 'commentary') {
      state.streamedCommentaryTexts.set(
        itemId,
        `${state.streamedCommentaryTexts.get(itemId) ?? ''}${delta}`,
      );
      await syncCommentaryTraceMessage(ctx, sessionId, state, itemId, 'running');
      return;
    }

    ensureStreamedAgentMessageSlot(state, itemId);
    state.streamedAgentMessageTexts.set(
      itemId,
      `${state.streamedAgentMessageTexts.get(itemId) ?? ''}${delta}`,
    );
    await syncStreamingAssistantMessage(
      ctx,
      sessionId,
      activeTurn.assistantMessageId,
      getStreamedAgentMessageContent(state),
    );
    return;
  }

  if (method === 'item/commandExecution/outputDelta') {
    if (!matchesHandledNotificationScope(activeTurn, state, params, activeTurnCountForCwd)) {
      return;
    }

    const itemId = typeof params.itemId === 'string' ? params.itemId : '';
    const delta = typeof params.delta === 'string' ? params.delta : '';
    const snapshot = itemId ? state.traceItemSnapshots.get(itemId) : undefined;
    if (!itemId || !delta || !snapshot) {
      return;
    }

    await syncCommandTraceMessage(
      ctx,
      sessionId,
      state,
      itemId,
      {
        ...snapshot,
        aggregatedOutput: `${typeof snapshot.aggregatedOutput === 'string' ? snapshot.aggregatedOutput : typeof snapshot.aggregated_output === 'string' ? snapshot.aggregated_output : ''}${delta}`,
      },
      'started',
    );
    return;
  }

  if (method === 'item/mcpToolCall/progress') {
    if (!matchesHandledNotificationScope(activeTurn, state, params, activeTurnCountForCwd)) {
      return;
    }

    const itemId = typeof params.itemId === 'string' ? params.itemId : '';
    const message = typeof params.message === 'string' ? params.message : '';
    const snapshot = itemId ? state.traceItemSnapshots.get(itemId) : undefined;
    if (!itemId || !message || !snapshot) {
      return;
    }

    appendToolProgressMessage(state, itemId, message);
    await syncFunctionTraceMessage(ctx, sessionId, state, itemId, snapshot, 'started');
  }
};

export const runCodexAppServerTurn = async (
  ctx: ClaudeInteractionContext,
  sessionId: string,
  prompt: string,
  pendingAttachments: PendingAttachment[] = [],
  fallbackSession?: SessionSummary,
  options?: CodexAppServerTurnOptions & {
    client?: CodexAppServerClient;
    disconnectOnFinish?: boolean;
    onThreadReady?: (threadId: string) => void;
  },
) => {
  if (activeAppServerTurns.has(sessionId)) {
    throw new Error('Codex app-server turn is already running for this session.');
  }

  const prepared = await prepareCodexRun(ctx, sessionId, prompt, pendingAttachments, fallbackSession, {
    references: options?.references,
  });
  const requestedModel = options?.model?.trim() || prepared.session.model;

  const activeTurn: ActiveAppServerTurn = {
    sessionId,
    assistantMessageId: prepared.assistantMessageId,
    threadId: '',
    turnId: null,
    cwd: prepared.session.workspace,
    stopped: false,
    completed: false,
    disconnectOnFinish: options?.disconnectOnFinish ?? true,
    traceMessages: new Map(),
  };
  activeAppServerTurns.set(sessionId, activeTurn);
  emitRuntimeState(ctx, sessionId, 'running', true);

  let client: CodexAppServerClient | null = options?.client ?? null;
  let notificationHandler: ((n: { method: string; params: Record<string, unknown> }) => void) | null =
    null;
  let clientExitHandler: ((error: Error) => void) | null = null;

  try {
    if (!client) {
      client = await appServerManager.acquire(prepared.session.workspace);
    }

    // Start or resume thread.
    let threadId = prepared.session.codexThreadId?.trim() || '';
    if (threadId) {
      try {
        const resumed = await client.threadResume({
          threadId,
          cwd: prepared.session.workspace,
          model: requestedModel ?? null,
        });
        threadId = resumed.thread.id;
      } catch {
        // Thread expired or invalid — start fresh.
        const started = await client.threadStart({
          cwd: prepared.session.workspace,
          model: requestedModel ?? null,
          ephemeral: false,
        });
        threadId = started.thread.id;
      }
    } else {
      const started = await client.threadStart({
        cwd: prepared.session.workspace,
        model: requestedModel ?? null,
        ephemeral: false,
      });
      threadId = started.thread.id;
    }

    activeTurn.threadId = threadId;
    options?.onThreadReady?.(threadId);
    await setSessionRuntime(sessionId, { codexThreadId: threadId });
    await syncCodexThreadTitle(client, threadId, prepared.session.title);

    // Set up notification handler and start the turn.
    const state: TurnCaptureState = {
      turnId: null,
      finalContent: '',
      tokenUsage: undefined,
      error: '',
      completed: false,
      finalAnswerSeen: false,
      completionTimer: null,
      traceMessages: activeTurn.traceMessages,
      streamedAgentMessageOrder: [],
      streamedAgentMessageTexts: new Map(),
      streamedCommentaryTexts: new Map(),
      agentMessagePhases: new Map(),
      traceItemSnapshots: new Map(),
      toolProgressMessages: new Map(),
    };
    let notificationQueue = Promise.resolve();

    notificationHandler = (notification: { method: string; params: Record<string, unknown> }) => {
      if (activeTurn.stopped) return;
      notificationQueue = notificationQueue
        .then(() =>
          handleAppServerNotification(
            ctx,
            sessionId,
            activeTurn,
            state,
            completionResolve,
            notification,
            countActiveAppServerTurnsForCwd(activeTurn.cwd),
          ),
        )
        .catch((error) => {
          state.error =
            state.error ||
            (error instanceof Error ? error.message : 'Codex app-server notification handling failed.');
          state.completed = true;
          clearCompletionTimer(state);
          completionResolve(state);
        });
    };
    let completionResolve: (state: TurnCaptureState) => void;
    const completionPromise = new Promise<TurnCaptureState>((resolve) => {
      completionResolve = resolve;
    });
    activeTurn.settle = () => {
      if (state.completed) {
        return;
      }

      state.completed = true;
      clearCompletionTimer(state);
      completionResolve(state);
    };
    client!.addNotificationHandler(notificationHandler);
    clientExitHandler = (error: Error) => {
      if (activeTurn.stopped || state.completed) {
        return;
      }

      state.error = state.error || error.message || 'Codex app-server process exited.';
      activeTurn.settle?.();
    };
    client.addExitHandler(clientExitHandler);

    if (activeTurn.stopped) {
      activeTurn.settle?.();
      await completionPromise;
    } else {
      const turnResponse = await client.turnStart({
        threadId,
        prompt: prepared.resolvedPrompt,
        model: requestedModel ?? null,
        outputSchema: options?.outputSchema ?? null,
      });

      if (!state.turnId && turnResponse.turn?.id) {
        state.turnId = turnResponse.turn.id;
        activeTurn.turnId = turnResponse.turn.id;
      }

      // If the turn completed synchronously.
      if (turnResponse.turn?.status && turnResponse.turn.status !== 'inProgress') {
        state.completed = true;
      }

      if (!state.completed) {
        await completionPromise;
      }
    }

    await notificationQueue;

    clearCompletionTimer(state);
    client.removeNotificationHandler(notificationHandler);
    if (clientExitHandler) {
      client.removeExitHandler(clientExitHandler);
    }
    activeTurn.settle = undefined;
    activeAppServerTurns.delete(sessionId);

    if (activeTurn.stopped) {
      if (activeTurn.disconnectOnFinish) {
        emitRuntimeState(ctx, sessionId, 'inactive', false);
      } else {
        emitResidentRuntimeState(ctx, sessionId);
      }
      return {
        projects: await getProjects(),
        queued: {
          sessionId,
          userMessageId: prepared.userMessageId,
          assistantMessageId: prepared.assistantMessageId,
        },
      };
    }

    if (state.error && !state.finalContent) {
      await updateAssistantMessage(sessionId, prepared.assistantMessageId, (message) => {
        message.title = 'Codex error';
        message.content = state.error;
        message.status = 'error';
      });
      await setSessionRuntime(sessionId, {
        model: requestedModel,
        preview: state.error,
        timeLabel: 'Just now',
      });
      ctx.broadcastEvent({
        type: 'status',
        sessionId,
        messageId: prepared.assistantMessageId,
        status: 'error',
        title: 'Codex error',
        content: state.error,
      });
      if (activeTurn.disconnectOnFinish) {
        emitRuntimeState(ctx, sessionId, 'inactive', false);
        appServerManager.release(prepared.session.workspace);
      } else {
        emitResidentRuntimeState(ctx, sessionId);
      }
      return {
        projects: await getProjects(),
        queued: {
          sessionId,
          userMessageId: prepared.userMessageId,
          assistantMessageId: prepared.assistantMessageId,
        },
      };
    }

    const rawContent = state.finalContent.trim() || 'No response.';
    const content = options?.parseFinalMessage
      ? options.parseFinalMessage(rawContent)
      : rawContent;
    activeTurn.completed = true;

    await updateAssistantMessage(sessionId, prepared.assistantMessageId, (message) => {
      message.title = buildMessageTitle(content, 'Codex response');
      message.content = content;
      message.status = 'complete';
    });
    await setSessionRuntime(sessionId, {
      model: requestedModel,
      tokenUsage: state.tokenUsage,
      preview: content,
      timeLabel: 'Just now',
    });
    ctx.broadcastEvent({
      type: 'complete',
      sessionId,
      messageId: prepared.assistantMessageId,
      content,
      tokenUsage: state.tokenUsage,
    });
    if (activeTurn.disconnectOnFinish) {
      emitRuntimeState(ctx, sessionId, 'inactive', false);
      appServerManager.release(prepared.session.workspace);
    } else {
      emitResidentRuntimeState(ctx, sessionId);
    }

    return {
      projects: await getProjects(),
      queued: {
        sessionId,
        userMessageId: prepared.userMessageId,
        assistantMessageId: prepared.assistantMessageId,
      },
    };
  } catch (error) {
    activeAppServerTurns.delete(sessionId);
    const errorMessage = error instanceof Error ? error.message : 'Codex app-server failed.';

    await updateAssistantMessage(sessionId, prepared.assistantMessageId, (message) => {
      message.title = 'Codex error';
      message.content = errorMessage;
      message.status = 'error';
    });
    ctx.broadcastEvent({
      type: 'error',
      sessionId,
      messageId: prepared.assistantMessageId,
      error: errorMessage,
    });
    if (activeTurn.disconnectOnFinish) {
      emitRuntimeState(ctx, sessionId, 'inactive', false);
    } else {
      emitResidentRuntimeState(ctx, sessionId);
    }

    if (client) {
      // Clean up the notification handler that may have been added before the error.
      if (notificationHandler) {
        client.removeNotificationHandler(notificationHandler);
      }
      if (clientExitHandler) {
        client.removeExitHandler(clientExitHandler);
      }
      if (activeTurn.disconnectOnFinish) {
        appServerManager.release(prepared.session.workspace);
      }
    }

    return {
      projects: await getProjects(),
      queued: {
        sessionId,
        userMessageId: prepared.userMessageId,
        assistantMessageId: prepared.assistantMessageId,
      },
    };
  }
};

export const interruptCodexAppServerTurn = async (
  ctx: ClaudeInteractionContext,
  sessionId: string,
  options?: { keepConnected?: boolean },
) => {
  const activeTurn = activeAppServerTurns.get(sessionId);
  if (!activeTurn) {
    return { projects: await getProjects() };
  }

  const keepConnected = options?.keepConnected ?? Boolean(getResidentAppServerSession(sessionId));

  activeTurn.stopped = true;
  activeTurn.settle?.();

  if (activeTurn.threadId && activeTurn.turnId) {
    let acquiredInterruptClient = false;
    try {
      const client = await appServerManager.acquire(activeTurn.cwd);
      acquiredInterruptClient = true;
      await client.turnInterrupt({ threadId: activeTurn.threadId, turnId: activeTurn.turnId });
    } catch {
      // Best-effort interrupt.
    } finally {
      if (acquiredInterruptClient) {
        appServerManager.release(activeTurn.cwd);
      }
    }
  }

  const result = await stopPendingSessionMessages(sessionId);
  result.changedMessages.forEach((message) => {
    if (message.role === 'assistant') {
      ctx.broadcastEvent({
        type: 'status',
        sessionId,
        messageId: message.id,
        status: message.status,
        title: message.title,
        content: message.content,
      });
    } else {
      ctx.broadcastEvent({
        type: 'trace',
        sessionId,
        message,
      });
    }
  });

  if (keepConnected) {
    emitResidentRuntimeState(ctx, sessionId);
  } else {
    emitRuntimeState(ctx, sessionId, 'inactive', false);
  }
  activeAppServerTurns.delete(sessionId);
  if (activeTurn.disconnectOnFinish) {
    appServerManager.release(activeTurn.cwd);
  }

  return { projects: result.projects };
};

export const disconnectCodexAppServerTurn = async (
  ctx: ClaudeInteractionContext,
  sessionId: string,
) => {
  const activeTurn = activeAppServerTurns.get(sessionId);
  if (activeTurn) {
    await interruptCodexAppServerTurn(ctx, sessionId, { keepConnected: false });
  }

  await disconnectResidentCodexSessionInternal(ctx, sessionId, !activeTurn);
  return { projects: await getProjects() };
};

export const runResidentCodexAppServerTurn = async (
  ctx: ClaudeInteractionContext,
  sessionId: string,
  prompt: string,
  pendingAttachments: PendingAttachment[] = [],
  fallbackSession?: SessionSummary,
  options?: CodexAppServerTurnOptions,
) => {
  const resident = await connectResidentCodexSession(ctx, sessionId, fallbackSession);
  return runCodexAppServerTurn(ctx, sessionId, prompt, pendingAttachments, fallbackSession, {
    ...options,
    client: resident.client,
    disconnectOnFinish: false,
    onThreadReady: (threadId) => {
      resident.threadId = threadId;
    },
  });
};

export const getCodexAppServerInteractionSnapshots = (): Record<string, SessionInteractionState> => {
  const snapshots: Record<string, SessionInteractionState> = {};
  residentAppServerSessions.forEach((resident, sessionId) => {
    snapshots[sessionId] = {
      runtime: {
        processActive: true,
        phase: getResidentRuntimePhase(sessionId),
        updatedAt: Date.now(),
      },
    };
  });
  return snapshots;
};
