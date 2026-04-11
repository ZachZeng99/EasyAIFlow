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
  setSessionRuntime,
  updateAssistantMessage,
} from '../electron/sessionStore.js';
import { stopPendingSessionMessages } from '../electron/sessionStop.js';
import { appServerManager, type CodexAppServerClient } from './codexAppServer.js';
import type {
  ConversationMessage,
  ContextReference,
  PendingAttachment,
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
  traceMessages: Map<string, ConversationMessage>;
};

const activeAppServerTurns = new Map<string, ActiveAppServerTurn>();

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

export const handleAppServerNotification = async (
  ctx: ClaudeInteractionContext,
  sessionId: string,
  activeTurn: ActiveAppServerTurn,
  state: TurnCaptureState,
  resolve: (state: TurnCaptureState) => void,
  notification: { method: string; params: Record<string, unknown> },
) => {
  const { method, params } = notification;

  if (method === 'turn/started') {
    const turn = params.turn as { id?: string } | undefined;
    if (turn?.id && !state.turnId) {
      state.turnId = turn.id;
      activeTurn.turnId = turn.id;
    }
    return;
  }

  if (method === 'turn/completed') {
    state.completed = true;
    clearCompletionTimer(state);
    resolve(state);
    return;
  }

  if (method === 'error') {
    const error = params.error as { message?: string } | undefined;
    state.error = error?.message ?? 'Codex app-server error';
    state.completed = true;
    clearCompletionTimer(state);
    resolve(state);
    return;
  }

  if (method === 'item/started' || method === 'item/completed') {
    const item = params.item as Record<string, unknown> | undefined;
    if (!item) return;

    const itemType = typeof item.type === 'string' ? item.type : '';
    const lifecycle = method === 'item/started' ? 'started' : 'completed';

    if (itemType === 'commandExecution') {
      const previous = typeof item.id === 'string' ? state.traceMessages.get(item.id) : undefined;
      const trace = buildCodexCommandTraceMessage({
        item: item as Parameters<typeof buildCodexCommandTraceMessage>[0]['item'],
        status: lifecycle === 'started'
          ? 'running'
          : (typeof item.exitCode === 'number' || typeof item.exit_code === 'number') &&
              ((item.exitCode as number) !== 0 && (item.exit_code as number) !== 0)
            ? 'error'
            : 'success',
        previous,
      });
      if (trace && typeof item.id === 'string') {
        state.traceMessages.set(item.id, trace);
        await emitTraceMessage(ctx, sessionId, trace);
      }
      return;
    }

    if (itemType === 'mcpToolCall' || itemType === 'dynamicToolCall' || itemType === 'function_call' || itemType === 'function_call_output') {
      const callId = typeof item.call_id === 'string' ? item.call_id : (typeof item.id === 'string' ? item.id : undefined);
      if (!callId) return;
      const previous = state.traceMessages.get(callId);
      const trace = buildCodexFunctionCallTraceMessage({
        item: item as Parameters<typeof buildCodexFunctionCallTraceMessage>[0]['item'],
        status: lifecycle === 'started' ? 'running' : 'success',
        previous,
        title: typeof item.name === 'string' ? item.name : (typeof item.tool === 'string' ? item.tool : undefined),
      });
      if (trace) {
        state.traceMessages.set(callId, trace);
        await emitTraceMessage(ctx, sessionId, trace);
      }
      return;
    }

    if (itemType === 'agentMessage') {
      const itemId = typeof item.id === 'string' ? item.id : '';
      const text = typeof item.text === 'string' ? item.text : '';
      const phase = typeof item.phase === 'string' ? item.phase : '';
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
    const itemId = typeof params.itemId === 'string' ? params.itemId : '';
    const delta = typeof params.delta === 'string' ? params.delta : '';
    if (!itemId || !delta) {
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
  }
};

export const runCodexAppServerTurn = async (
  ctx: ClaudeInteractionContext,
  sessionId: string,
  prompt: string,
  pendingAttachments: PendingAttachment[] = [],
  fallbackSession?: SessionSummary,
  options?: CodexAppServerTurnOptions,
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
    traceMessages: new Map(),
  };
  activeAppServerTurns.set(sessionId, activeTurn);
  emitRuntimeState(ctx, sessionId, 'running', true);

  let client: CodexAppServerClient | null = null;

  try {
    client = await appServerManager.acquire(prepared.session.workspace);

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
    await setSessionRuntime(sessionId, { codexThreadId: threadId });

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
    };
    let notificationQueue = Promise.resolve();

    const completionPromise = new Promise<TurnCaptureState>((resolve) => {
      client!.setNotificationHandler((notification) => {
        if (activeTurn.stopped) return;
        notificationQueue = notificationQueue
          .then(() =>
            handleAppServerNotification(ctx, sessionId, activeTurn, state, resolve, notification),
          )
          .catch((error) => {
            state.error =
              state.error ||
              (error instanceof Error ? error.message : 'Codex app-server notification handling failed.');
            state.completed = true;
            clearCompletionTimer(state);
            resolve(state);
          });
      });
    });

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
      // Wait for completion with a timeout.
      const timeoutMs = 300_000;
      const timeoutPromise = new Promise<TurnCaptureState>((resolve) => {
        setTimeout(() => {
          if (!state.completed) {
            state.completed = true;
            state.error = state.error || (state.finalContent ? '' : 'Codex turn timed out.');
            resolve(state);
          }
        }, timeoutMs);
      });

      await Promise.race([completionPromise, timeoutPromise]);
    }

    await notificationQueue;

    clearCompletionTimer(state);
    client.setNotificationHandler(null);
    activeAppServerTurns.delete(sessionId);

    if (activeTurn.stopped) {
      emitRuntimeState(ctx, sessionId, 'inactive', false);
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
      emitRuntimeState(ctx, sessionId, 'inactive', false);
      appServerManager.release(prepared.session.workspace);
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
    emitRuntimeState(ctx, sessionId, 'inactive', false);
    appServerManager.release(prepared.session.workspace);

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
    emitRuntimeState(ctx, sessionId, 'inactive', false);

    if (client) {
      appServerManager.release(prepared.session.workspace);
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
) => {
  const activeTurn = activeAppServerTurns.get(sessionId);
  if (!activeTurn) {
    return { projects: await getProjects() };
  }

  activeTurn.stopped = true;

  if (activeTurn.threadId && activeTurn.turnId) {
    try {
      const client = await appServerManager.acquire(activeTurn.cwd);
      await client.turnInterrupt({ threadId: activeTurn.threadId, turnId: activeTurn.turnId });
      appServerManager.release(activeTurn.cwd);
    } catch {
      // Best-effort interrupt.
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

  emitRuntimeState(ctx, sessionId, 'inactive', false);
  activeAppServerTurns.delete(sessionId);
  appServerManager.release(activeTurn.cwd);

  return { projects: result.projects };
};

export const disconnectCodexAppServerTurn = interruptCodexAppServerTurn;
