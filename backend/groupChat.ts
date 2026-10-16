import { randomUUID } from 'node:crypto';
import type { ClaudeInteractionContext } from './claudeInteractionContext.js';
import type { ClaudeInteractionState, ClaudePrintOptions, SessionBroadcastInterceptor } from './claudeInteractionState.js';
import { addSessionBroadcastInterceptor, removeSessionBroadcastInterceptor } from './claudeInteractionState.js';
import { buildMessageTitle, nowLabel } from './claudeHelpers.js';
import { createSerialAsyncQueue } from '../electron/serialAsyncQueue.js';
import {
  disconnectSession,
  interruptSessionTurn,
  runClaudePrint,
} from './claudeInteraction.js';
import {
  runCodexAppServerTurn,
  interruptCodexAppServerTurn,
  disconnectCodexAppServerTurn,
} from './codexAppServerTurn.js';
import {
  appendMessagesToSession,
  configureGroupParticipants,
  ensureGroupRoomBackingSessions,
  findSession,
  getProjects,
  getSessionRecordForBootstrap,
  releaseMaterializedSessionHistory,
  updateAssistantMessage,
  updateSessionRecord,
  upsertSessionMessage,
} from '../electron/sessionStore.js';
import { stopPendingSessionMessages } from '../electron/sessionStop.js';
import type {
  ClaudeStreamEvent,
  ConversationMessage,
  GroupParticipant,
  GroupParticipantConfig,
  GroupParticipantId,
  PendingAttachment,
  SessionRecord,
  SessionRuntimePhase,
  SessionSummary,
} from '../src/data/types.js';
import { resolveGroupTargets } from '../src/data/groupChat.js';
import { GroupTurnCoordinator } from './groupTurnCoordinator.js';
import type { SessionInteractionState } from '../src/data/sessionInteraction.js';
import { RpcRejectedError } from '../src/data/rpcOperations.js';
import { agentMessagingFor, type TeamTaskContext, type TeamToolConfig } from './agentMessaging.js';

const coordinators = new WeakMap<ClaudeInteractionState, GroupTurnCoordinator>();
const coordinatorFor = (state: ClaudeInteractionState) => {
  let coordinator = coordinators.get(state);
  if (!coordinator) { coordinator = new GroupTurnCoordinator(); coordinators.set(state, coordinator); }
  return coordinator;
};
export const hasActiveGroupTurns = (state: ClaudeInteractionState, roomId?: string) => coordinatorFor(state).hasWork(roomId);
export const updateGroupParticipants = (
  ctx: ClaudeInteractionContext,
  state: ClaudeInteractionState,
  payload: { sessionId: string; expectedRevision: number; participants: GroupParticipantConfig[]; collaborationEnabled?: boolean },
) => coordinatorFor(state).dispatch(payload.sessionId, async () => {
  const session = await findSession(payload.sessionId);
  if (hasActiveGroupTurns(state, payload.sessionId) || session?.messages.some((message) => ['queued', 'streaming', 'running', 'background'].includes(message.status ?? ''))) {
    throw new RpcRejectedError('请等待群聊任务结束，或先停止任务，再修改成员。');
  }
  const result = await configureGroupParticipants(payload.sessionId, payload.expectedRevision, payload.participants, payload.collaborationEnabled);
  ctx.broadcastEvent({ type: 'session-sync', sessionId: result.session.id, session: result.session });
  return result;
});
export const getGroupInteractionSnapshots = (state: ClaudeInteractionState): Record<string, SessionInteractionState> =>
  Object.fromEntries(coordinatorFor(state).pendingCounts().map(([sessionId, pendingTurns]) => [sessionId, {
    runtime: { processActive: true, phase: 'running', pendingTurns, updatedAt: Date.now() },
  }]));

type GroupSendPayload = {
  sessionId: string;
  prompt: string;
  attachments?: PendingAttachment[];
  session?: SessionSummary;
  model?: string;
  effort?: ClaudePrintOptions['effort'];
  targetParticipantIds?: string[];
};

type GroupMirrorSpec = {
  roomSessionId: string;
  backingSessionId: string;
  participant: GroupParticipant;
  roomAssistantMessageId: string;
  backingAssistantMessageId?: string;
};

const isMissingSessionError = (error: unknown) =>
  error instanceof Error && error.message === 'Session not found.';

export const ignoreMissingSessionError = async <T>(
  operation: () => Promise<T>,
  onMissing?: () => void,
): Promise<T | null> => {
  try {
    return await operation();
  } catch (error) {
    if (isMissingSessionError(error)) {
      onMissing?.();
      return null;
    }
    throw error;
  }
};

const isGroupRoomSession = (
  session: SessionSummary | SessionRecord | null | undefined,
): session is SessionRecord & {
  sessionKind: 'group';
  group: {
    kind: 'room';
    nextMessageSeq: number;
    participants: GroupParticipant[];
  };
} => Boolean(session?.sessionKind === 'group' && session.group?.kind === 'room');

const formatGroupEventForSync = (message: ConversationMessage) => {
  const seqLabel = typeof message.seq === 'number' ? `#${message.seq}` : '#?';
  const speaker = message.speakerLabel?.trim() || (message.role === 'user' ? 'User' : 'Assistant');
  const kind = message.kind ?? 'message';
  const status = message.status ? ` status=${message.status}` : '';
  const title = message.title?.trim() ? ` title="${message.title.trim()}"` : '';
  const body = message.content.trim() || '(empty)';

  return `${seqLabel} [${speaker}] [${kind}${status}]${title}\n${body}`;
};

const getLatestTargetedUserMessage = (
  pendingMessages: ConversationMessage[],
  participant: GroupParticipant,
) =>
  [...pendingMessages]
    .reverse()
    .find(
      (message) =>
        message.role === 'user' &&
        (message.targetParticipantIds?.includes(participant.id) ?? false),
    ) ??
  [...pendingMessages].reverse().find((message) => message.role === 'user');

export const buildRoomSyncPrompt = (
  roomSession: SessionRecord,
  participant: GroupParticipant,
  pendingMessages: ConversationMessage[],
  snapshotSeq: number,
) => {
  const latestTargetedMessage =
    [...pendingMessages]
      .reverse()
      .find(
        (message) =>
          message.role === 'user' &&
          (message.targetParticipantIds?.includes(participant.id) ?? false),
      ) ??
    [...pendingMessages].reverse().find((message) => message.role === 'user');
  const participantList = roomSession.group?.kind === 'room'
    ? roomSession.group.participants.map((candidate) => candidate.label).join(', ')
    : 'You, Claude, Codex';
  const syncLines =
    pendingMessages.length > 0
      ? pendingMessages.map((message) => formatGroupEventForSync(message)).join('\n\n')
      : 'No new room events.';
  const addressedBlock = latestTargetedMessage
    ? formatGroupEventForSync(latestTargetedMessage)
    : 'No addressed user message was found.';

  if (isGreetingOnly(pendingMessages)) {
    return [
      '<task>',
      `A user greeted ${participant.label} in the group chat. Reply with a brief greeting in the same language.`,
      '</task>',
      '',
      '<compact_output_contract>',
      `Return only a short greeting from ${participant.label}. Do not introduce yourself, describe your role, or ask for tasks.`,
      '</compact_output_contract>',
      '',
      `ROOM_CONTEXT through message #${snapshotSeq}:`,
      `Participants: ${participantList}.`,
      syncLines,
    ].join('\n');
  }

  return [
    '<task>',
    `You are ${participant.label} in a shared chat room about the current workspace.`,
    `Your address is @${participant.id}.`,
    ...(participant.instructions ? ['Your assigned role:', participant.instructions, ''] : []),
    'Decide whether TARGET_MESSAGE is asking for:',
    '1. A direct answer, explanation, or opinion.',
    '2. Real work in the workspace, such as investigation, edits, commands, tests, verification, or continuing previously promised work.',
    '',
    'If it is (2), do the work before replying. Use tools when they help. Do not stop at a plan or promise.',
    'If the user is calling out missing follow-through on work you already said you would do, treat that as (2): continue the work and return concrete results.',
    'If it is only (1), answer directly.',
    '',
    'TARGET_MESSAGE:',
    addressedBlock,
    '',
    `ROOM_CONTEXT through message #${snapshotSeq}:`,
    `Participants: ${participantList}.`,
    syncLines,
    '</task>',
    '',
    '<compact_output_contract>',
    `Return ${participant.label}'s answer in the same language the user used.`,
    'If you performed work, include only concrete results that actually happened, such as changed files, commands run, test results, or a precise blocker.',
    'Do not say you will do work later if you have not done it in this turn.',
    `Do not introduce yourself or describe your role as ${participant.label}.`,
    '</compact_output_contract>',
    '',
    '<verification_loop>',
    'Before finalizing, verify that you either answered the question directly or actually performed the requested work.',
    'Do not ask the user to repeat content that is already shown in ROOM_CONTEXT.',
    '</verification_loop>',
  ].join('\n');
};

const isGreetingOnly = (messages: ConversationMessage[]) => {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  if (!lastUser) return false;
  const cleaned = lastUser.content.replace(/@[a-z][a-z0-9_-]*\s*/gi, '').trim();
  return /^(大家好|你好|hello|hi|hey|嗨|哈喽)[\s!！.。]*$/i.test(cleaned);
};

export const buildCodexRoomChatPrompt = (
  participant: GroupParticipant,
  pendingMessages: ConversationMessage[],
) => {
  const chatLines: string[] = [];
  const latestTargetedMessage = getLatestTargetedUserMessage(pendingMessages, participant);
  const latestParticipantReply = [...pendingMessages].reverse().find((message) => message.role === 'assistant');
  const targetBlock = latestTargetedMessage
    ? formatGroupEventForSync(latestTargetedMessage)
    : 'No targeted user message was found.';
  const latestReplyBlock = latestParticipantReply
    ? formatGroupEventForSync(latestParticipantReply)
    : 'No previous participant reply was found.';

  for (const message of pendingMessages) {
    const speaker =
      message.role === 'user'
        ? 'You'
        : message.speakerLabel || 'Assistant';
    chatLines.push(`${speaker}: ${message.content.trim()}`);
  }

  const transcript = chatLines.join('\n');

  if (isGreetingOnly(pendingMessages)) {
    return [
      '<task>',
      'A user greeted the group chat. Reply with a brief greeting in the same language.',
      '</task>',
      '',
      '<compact_output_contract>',
      'Return only a short greeting. Do not introduce yourself, describe your role, or ask for tasks.',
      '</compact_output_contract>',
      '',
      transcript,
    ].join('\n');
  }

  return [
    '<task>',
    `You are ${participant.label} in a group chat about the current workspace.`,
    `Your address is @${participant.id}.`,
    ...(participant.instructions ? ['Your assigned role:', participant.instructions, ''] : []),
    'Decide whether TARGET_MESSAGE is asking for:',
    '1. A direct answer, explanation, or opinion.',
    '2. Real work in the workspace, such as investigation, edits, commands, tests, verification, or continuing previously promised work.',
    '',
    'If it is (2), do the work before replying. Use tools when they help. Do not stop at a plan or promise.',
    'If the user is calling out missing follow-through on work you already said you would do, treat that as (2): continue the work and return concrete results.',
    'If it is only (1), answer directly.',
    '',
    'TARGET_MESSAGE:',
    targetBlock,
    '',
    'LATEST_PARTICIPANT_REPLY:',
    latestReplyBlock,
    '',
    'If TARGET_MESSAGE asks whether another participant\'s reply is correct, use LATEST_PARTICIPANT_REPLY and Chat context directly.',
    'Do not ask the user to repeat content that is already shown below.',
    '',
    'Chat context:',
    transcript,
    '</task>',
    '',
    '<compact_output_contract>',
    'Return your answer in the same language the user used. Do not introduce yourself or describe your role.',
    'If you performed work, include only concrete results that actually happened, such as changed files, key diff, test results, or a precise blocker.',
    'Do not say you will do work later if you have not done it in this turn.',
    '</compact_output_contract>',
    '',
    '<verification_loop>',
    'Before finalizing, verify that you either answered the question directly or actually performed the requested work.',
    'Never claim edits, commands, tests, or follow-up that did not happen.',
    'Do not contain self-introductions or role descriptions.',
    '</verification_loop>',
  ].join('\n');
};

const buildMirroredTraceId = (roomSessionId: string, participantId: GroupParticipantId, sourceId: string) =>
  `group-trace-${roomSessionId}-${participantId}-${sourceId}`;

const mirrorTraceMessage = async (
  ctx: ClaudeInteractionContext,
  spec: GroupMirrorSpec,
  message: ConversationMessage,
) => {
  if (message.role !== 'system') {
    return;
  }
  if (message.nativeAgent && message.nativeAgent.rootAssistantMessageId !== spec.backingAssistantMessageId) return;

  const mirroredMessage: ConversationMessage = {
    ...message,
    id: buildMirroredTraceId(spec.roomSessionId, spec.participant.id, message.id),
    speakerId: spec.participant.id,
    speakerLabel: spec.participant.label,
    provider: spec.participant.provider,
    sourceSessionId: spec.backingSessionId,
    ...(message.nativeAgent ? { nativeAgent: { ...message.nativeAgent, rootAssistantMessageId: spec.roomAssistantMessageId } } : {}),
  };

  const updated = await ignoreMissingSessionError(
    () => upsertSessionMessage(spec.roomSessionId, mirroredMessage),
    () => {
      console.warn(
        '[GROUP] Skipped mirrored trace for missing room session',
        spec.roomSessionId,
        'from backing session',
        spec.backingSessionId,
      );
    },
  );
  if (updated === null) {
    return;
  }
  ctx.broadcastEvent({
    type: 'trace',
    sessionId: spec.roomSessionId,
    sourceSessionId: spec.backingSessionId,
    message: mirroredMessage,
  });
};

export const mirrorAssistantEvent = async (
  ctx: ClaudeInteractionContext,
  spec: GroupMirrorSpec,
  event: Extract<ClaudeStreamEvent, { type: 'status' | 'delta' | 'complete' | 'error' }>,
) => {
  const roomSession = await findSession(spec.roomSessionId);
  if (!roomSession) {
    console.warn(
      '[GROUP] Skipped mirrored assistant event for missing room session',
      spec.roomSessionId,
      'from backing session',
      spec.backingSessionId,
      'event',
      event.type,
    );
    return;
  }

  const resolvedRoomMessageId = resolveMirroredAssistantRoomMessageId(spec, roomSession, event.messageId);
  if (!resolvedRoomMessageId) {
    return;
  }

  if (event.type === 'delta') {
    const updated = await ignoreMissingSessionError(
      () =>
        updateAssistantMessage(spec.roomSessionId, resolvedRoomMessageId, (message) => {
          message.content += event.delta;
          message.status = 'streaming';
        }),
      () => {
        console.warn(
          '[GROUP] Skipped mirrored delta for missing room session',
          spec.roomSessionId,
          'from backing session',
          spec.backingSessionId,
        );
      },
    );
    if (updated === null) {
      return;
    }
    ctx.broadcastEvent({
      type: 'delta',
      sessionId: spec.roomSessionId,
      sourceSessionId: spec.backingSessionId,
      messageId: resolvedRoomMessageId,
      delta: event.delta,
    });
    return;
  }

  if (event.type === 'status') {
    const updated = await ignoreMissingSessionError(
      () =>
        updateAssistantMessage(spec.roomSessionId, resolvedRoomMessageId, (message) => {
          if (typeof event.content === 'string') {
            message.content = event.content;
          }
          if (typeof event.title === 'string') {
            message.title = event.title;
          }
          message.status = event.status;
        }),
      () => {
        console.warn(
          '[GROUP] Skipped mirrored status for missing room session',
          spec.roomSessionId,
          'from backing session',
          spec.backingSessionId,
        );
      },
    );
    if (updated === null) {
      return;
    }
    ctx.broadcastEvent({
      ...event,
      sessionId: spec.roomSessionId,
      sourceSessionId: spec.backingSessionId,
      messageId: resolvedRoomMessageId,
    });
    return;
  }

  if (event.type === 'complete') {
    const updated = await ignoreMissingSessionError(
      () =>
        updateSessionRecord(spec.roomSessionId, (session) => {
          const target = session.messages.find((message) => message.id === resolvedRoomMessageId);
          if (!target) {
            return;
          }

          target.title = `${spec.participant.label} response`;
          target.content = event.content;
          target.status = 'complete';
          session.preview = event.content || session.preview;
          session.timeLabel = 'Just now';
        }),
      () => {
        console.warn(
          '[GROUP] Skipped mirrored completion for missing room session',
          spec.roomSessionId,
          'from backing session',
          spec.backingSessionId,
        );
      },
    );
    if (updated === null) {
      return;
    }
    ctx.broadcastEvent({
      ...event,
      sessionId: spec.roomSessionId,
      sourceSessionId: spec.backingSessionId,
      messageId: resolvedRoomMessageId,
    });
    return;
  }

  const updated = await ignoreMissingSessionError(
    () =>
      updateSessionRecord(spec.roomSessionId, (session) => {
        const target = session.messages.find((message) => message.id === resolvedRoomMessageId);
        if (!target) {
          return;
        }

        target.title = `${spec.participant.label} error`;
        target.content = event.error;
        target.status = 'error';
        session.preview = `${spec.participant.label} error`;
        session.timeLabel = 'Just now';
      }),
    () => {
      console.warn(
        '[GROUP] Skipped mirrored error for missing room session',
        spec.roomSessionId,
        'from backing session',
        spec.backingSessionId,
      );
    },
  );
  if (updated === null) {
    return;
  }
  ctx.broadcastEvent({
    type: 'error',
    sessionId: spec.roomSessionId,
    sourceSessionId: spec.backingSessionId,
    messageId: spec.roomAssistantMessageId,
    error: event.error,
  });
};

export const resolveMirroredAssistantRoomMessageId = (
  spec: GroupMirrorSpec,
  _roomSession: SessionRecord,
  backingMessageId: string,
) => {
  return spec.backingAssistantMessageId === backingMessageId ? spec.roomAssistantMessageId : null;
};

export const createMirroredContext = (
  ctx: ClaudeInteractionContext,
  spec: GroupMirrorSpec,
  options?: {
    forwardOriginalEvents?: boolean;
  },
) => {
  // Serialize mirrored event processing to maintain delta ordering and prevent
  // concurrent read-modify-write races on the room session. A bounded queue
  // (not a `tail = tail.then(...)` chain) so a fast backing-session stream
  // cannot accumulate an unbounded promise graph in the room's lifetime.
  const mirrorQueue = createSerialAsyncQueue((error) => {
    console.error(
      '[GROUP] Failed to mirror event for room session',
      spec.roomSessionId,
      'from backing session',
      spec.backingSessionId,
      error,
    );
  });

  const mirroredCtx: ClaudeInteractionContext = {
    ...ctx,
    broadcastEvent: (event) => {
      if (!('sessionId' in event)) {
        return;
      }
      if (event.sessionId !== spec.backingSessionId) {
        return;
      }

      if (options?.forwardOriginalEvents) {
        ctx.broadcastEvent(event);
      }

      mirrorQueue.push(async () => {
        if (event.type === 'trace') {
          await mirrorTraceMessage(ctx, spec, event.message);
          return;
        }

        if (
          event.type === 'status' ||
          event.type === 'delta' ||
          event.type === 'complete' ||
          event.type === 'error'
        ) {
          await mirrorAssistantEvent(ctx, spec, event);
          return;
        }

        if (
          event.type === 'permission-request' ||
          event.type === 'ask-user-question' ||
          event.type === 'plan-mode-request' ||
          event.type === 'interaction-resolved' ||
          event.type === 'background-task'
        ) {
          ctx.broadcastEvent({
            ...event,
            sessionId: spec.roomSessionId,
            sourceSessionId: spec.backingSessionId,
          });
        }
      });
    },
  };

  return {
    ctx: mirroredCtx,
    flush: () => mirrorQueue.drain(),
  };
};

const buildRoomAssistantPlaceholder = (
  participant: GroupParticipant,
  backingSessionId: string,
): ConversationMessage => ({
  id: randomUUID(),
  role: 'assistant',
  timestamp: nowLabel(),
  title: `${participant.label} response`,
  content: '',
  speakerId: participant.id,
  speakerLabel: participant.label,
  provider: participant.provider,
  sourceSessionId: backingSessionId,
  status: 'queued',
});

const buildRoomUserMessage = (
  prompt: string,
  targetParticipantIds: GroupParticipantId[],
  attachments: PendingAttachment[],
): ConversationMessage => ({
  id: randomUUID(),
  role: 'user',
  timestamp: nowLabel(),
  title: buildMessageTitle(prompt, 'User prompt'),
  content: prompt,
  speakerId: 'user',
  speakerLabel: 'You',
  status: 'complete',
  targetParticipantIds,
  attachments: attachments.map((attachment) => ({
    id: attachment.id,
    name: attachment.name,
    path: attachment.path ?? attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
  })),
});

const broadcastGroupTrace = (
  ctx: ClaudeInteractionContext,
  roomSessionId: string,
  message: ConversationMessage,
  sourceSessionId?: string,
) => {
  ctx.broadcastEvent({
    type: 'trace',
    sessionId: roomSessionId,
    sourceSessionId,
    message,
  });
};

const markGroupParticipantStartError = async (
  ctx: ClaudeInteractionContext,
  roomSessionId: string,
  participant: GroupParticipant,
  placeholder: ConversationMessage,
  reason: unknown,
) => {
  const errorMessage =
    reason instanceof Error ? reason.message : `${participant.label} failed to start.`;
  await updateSessionRecord(roomSessionId, (session) => {
    const target = session.messages.find((message) => message.id === placeholder.id);
    if (!target) {
      return;
    }

    target.title = `${participant.label} error`;
    target.content = errorMessage;
    target.status = 'error';
    session.preview = `${participant.label} error`;
    session.timeLabel = 'Just now';
  });
  ctx.broadcastEvent({
    type: 'error',
    sessionId: roomSessionId,
    sourceSessionId: participant.backingSessionId,
    messageId: placeholder.id,
    error: errorMessage,
  });
};

export const getRoomSnapshotMessages = (
  roomSession: SessionRecord,
  snapshotSeq: number,
) => {
  // Revisit earlier sequence numbers: a reply can complete after a later user
  // message. Incremental seq watermarks alone would permanently skip it.
  const publicMessages = (roomSession.messages ?? []).filter(
    (message) =>
      typeof message.seq === 'number' &&
      message.seq <= snapshotSeq &&
      (message.role === 'user' || message.role === 'assistant') &&
      (!message.kind || message.kind === 'message') &&
      (message.status === undefined || message.status === 'complete' || message.status === 'success'),
  );
  // Keep the addressed user prompt intact and bound older public context.
  let remaining = 64 * 1024;
  const selected: ConversationMessage[] = [];
  for (const message of publicMessages.slice(-80).reverse()) {
    if (remaining <= 0 && message.seq !== snapshotSeq) break;
    const content = message.seq === snapshotSeq || message.content.length <= remaining
      ? message.content : `${message.content.slice(0, remaining)}\n[Earlier message excerpt truncated]`;
    selected.push({ ...message, content, targetParticipantIds: message.targetParticipantIds?.slice() });
    if (message.seq !== snapshotSeq) remaining -= content.length;
  }
  return selected.reverse();
};

const runGroupParticipantTurn = async (
  ctx: ClaudeInteractionContext,
  state: ClaudeInteractionState,
  roomSession: SessionRecord,
  participant: GroupParticipant,
  roomAssistantMessage: ConversationMessage,
  snapshotSeq: number,
  pendingAttachments: PendingAttachment[],
  payload: GroupSendPayload,
  signal: AbortSignal,
  teamContext: TeamTaskContext,
) => {
  signal.throwIfAborted();
  const backingSession = await findSession(participant.backingSessionId);
  if (!backingSession) {
    throw new Error(`${participant.label} backing session not found.`);
  }

  signal.throwIfAborted();
  const syncMessages = roomSession.messages;
  const basePrompt = participant.provider === 'codex'
    ? buildCodexRoomChatPrompt(participant, syncMessages)
    : buildRoomSyncPrompt(roomSession, participant, syncMessages, snapshotSeq);
  const collaboration = roomSession.group?.kind === 'room' && roomSession.group.collaborationEnabled === true;
  const syncPrompt = basePrompt + (collaboration ? '\n\nEAF_TEAM_TOOLS: The user enabled team collaboration for this room. Use the eaf_team MCP tools team_members, team_send and team_wait when delegation helps the task. Send only to listed enabled members. Native subagent tools do not address EAF members. A queued receipt is not a reply; use team_wait for the actual result before claiming completion. Return results to your requester by finishing your current reply; do not send back to an ancestor. Delegate only work within the user task. Use stable request_id values for retries. Maximum 16 delegated messages per user task and depth 4.' : '');
  const mirrorSpec: GroupMirrorSpec = {
    roomSessionId: roomSession.id,
    backingSessionId: backingSession.id,
    participant,
    roomAssistantMessageId: roomAssistantMessage.id,
  };
  const { ctx: mirroredCtx, flush: flushMirroredEvents } = createMirroredContext(ctx, mirrorSpec, {
    forwardOriginalEvents: participant.provider === 'codex',
  });

  // For Claude participants, register a persistent broadcast interceptor on the
  // backing session so that events produced by the resident stdout processor
  // (which holds the ctx from when the resident was first created, not the
  // current mirroredCtx) are also routed through the mirror.  The interceptor
  // stays alive until a terminal event (complete/error) arrives for our
  // assistant message, covering background tasks that outlive the initial turn.
  // Codex doesn't need this — runCodexAppServerTurn is fully synchronous and
  // its ctx is used directly throughout.
  let interceptor: SessionBroadcastInterceptor | undefined;
  let interceptorSettled: (() => void) | undefined;
  let backgroundSettled: Promise<void> | undefined;

  if (participant.provider !== 'codex') {
    backgroundSettled = new Promise<void>((resolve) => {
      interceptorSettled = resolve;
    });

    interceptor = (event) => {
      // Only handle events for the backing session.
      if (!('sessionId' in event)) {
        return;
      }
      if (event.sessionId !== backingSession.id) {
        return;
      }

      // Forward through the mirrored context so the room session gets updated.
      mirroredCtx.broadcastEvent(event);

      // When the assistant message reaches a terminal state, the interceptor
      // has done its job — unregister and signal settlement.
      if (
        mirrorSpec.backingAssistantMessageId &&
        'messageId' in event &&
        event.messageId === mirrorSpec.backingAssistantMessageId &&
        (event.type === 'complete' || event.type === 'error' ||
          (event.type === 'status' && (event.status === 'complete' || event.status === 'error')))
      ) {
        removeSessionBroadcastInterceptor(state, backingSession.id, interceptor!);
        interceptorSettled?.();
      }
    };

    addSessionBroadcastInterceptor(state, backingSession.id, interceptor);
  }

  const onAbort = () => interceptorSettled?.();
  signal.addEventListener('abort', onAbort, { once: true });
  const onPrepared = (messageId: string) => { mirrorSpec.backingAssistantMessageId = messageId; };
  let teamTools: TeamToolConfig | undefined;

  try {
    if (collaboration && roomSession.group?.kind === 'room') {
      teamTools = await agentMessagingFor(state).bind({
        sessionId: backingSession.id, roomId: roomSession.id, memberId: participant.id, memberLabel: participant.label,
        context: teamContext, signal, members: roomSession.group.participants,
        send: async (recipient, message, context) => {
          signal.throwIfAborted();
          const result = await sendGroupMessage(ctx, state, { sessionId: roomSession.id, prompt: message, targetParticipantIds: [recipient] }, context, signal);
          return { ...result.queued, recipient };
        },
        read: async (receipt) => {
          const room = await findSession(receipt.sessionId);
          const reply = room?.messages.find((message) => message.id === receipt.assistantMessageId);
          if (!reply) return { status: 'unknown' };
          if (reply.status === 'complete') return { status: 'replied', content: reply.content.slice(0, 24000), truncated: reply.content.length > 24000 };
          if (reply.status === 'error') return { status: 'failed', content: reply.content.slice(0, 24000) };
          return { status: reply.status === 'queued' ? 'queued' : 'running' };
        },
      });
    }
    // Codex: pass mirroredCtx directly and keep forwarding the original backing
    // events as well so hidden participant runtime stays in sync with the room.
    // Claude: pass the original ctx — the interceptor registered above handles
    // mirroring.  Passing mirroredCtx here would cause double-mirroring since
    // the resident proxy also dispatches through the interceptor.
    const result =
      participant.provider === 'codex'
        ? await runCodexAppServerTurn(
            mirroredCtx,
            backingSession.id,
            syncPrompt,
            pendingAttachments,
            backingSession,
            {
              references: roomSession.contextReferences ?? [],
              model: participant.model || backingSession.model || payload.model,
              effort: participant.effort ?? payload.effort,
              config: teamTools?.codexConfig,
              onPrepared,
              signal,
            },
          )
        : await runClaudePrint(
            ctx,
            state,
            backingSession.id,
            syncPrompt,
            pendingAttachments,
            backingSession,
            {
              references: roomSession.contextReferences ?? [],
              model: participant.model || backingSession.model || payload.model,
              effort: participant.effort ?? payload.effort,
              mcpConfigPath: teamTools?.claudeConfigPath,
              onPrepared,
              signal,
            },
          );

    mirrorSpec.backingAssistantMessageId = result.queued.assistantMessageId;

    await updateSessionRecord(roomSession.id, (session) => {
      if (session.group?.kind !== 'room') {
        return;
      }

      session.group.participants = session.group.participants.map((candidate) =>
        candidate.id === participant.id
          ? {
              ...candidate,
              lastAppliedRoomSeq: snapshotSeq,
              model: participant.model || backingSession.model || candidate.model,
            }
          : candidate,
      );
    });

    // Wait for the interceptor to see the terminal event (complete/error) so
    // background task results are mirrored before we return.
    if (backgroundSettled && !signal.aborted) {
      await backgroundSettled;
    }
    await flushMirroredEvents();
  } finally {
    teamTools?.release();
    signal.removeEventListener('abort', onAbort);
    // Safety net: always clean up the interceptor even if the turn throws.
    if (interceptor) {
      removeSessionBroadcastInterceptor(state, backingSession.id, interceptor);
      interceptorSettled?.();
    }
    await flushMirroredEvents();
  }
};

export const sendGroupMessage = async (
  ctx: ClaudeInteractionContext,
  state: ClaudeInteractionState,
  payload: GroupSendPayload,
  teamContext?: TeamTaskContext,
  teamSignal?: AbortSignal,
) => coordinatorFor(state).dispatch(payload.sessionId, () => {
  teamSignal?.throwIfAborted();
  return dispatchGroupMessage(ctx, state, payload, teamContext);
});

const dispatchGroupMessage = async (
  ctx: ClaudeInteractionContext,
  state: ClaudeInteractionState,
  payload: GroupSendPayload,
  teamContext?: TeamTaskContext,
) => {
  const roomSession =
    (await ensureGroupRoomBackingSessions(payload.sessionId).catch(() => null)) ??
    (payload.session ? await ensureGroupRoomBackingSessions(payload.session.id).catch(() => null) : null);
  if (!isGroupRoomSession(roomSession)) {
    throw new Error('Group session not found.');
  }

  const pendingAttachments = payload.attachments ?? [];
  const targets = resolveGroupTargets(
    teamContext ? '' : payload.prompt,
    roomSession.group.participants,
    roomSession.messages ?? [],
    payload.targetParticipantIds,
  );
  if (!targets.length) throw new Error('No enabled group recipient matches this message. Choose an available participant with @.');
  const userMessage = buildRoomUserMessage(payload.prompt, targets, pendingAttachments);
  if (teamContext?.senderId) {
    userMessage.speakerId = teamContext.senderId;
    userMessage.speakerLabel = `${teamContext.senderLabel || teamContext.senderId} → @${targets[0]}`;
    userMessage.title = `委派给 @${targets[0]}`;
    if (teamContext.deliveryId) userMessage.teamDelivery = { id: teamContext.deliveryId, rootTaskId: teamContext.rootTaskId, senderId: teamContext.senderId, recipientId: targets[0] };
  }
  const taskContext = teamContext ?? { rootTaskId: userMessage.id, ancestors: [] };
  const initialProjects = await appendMessagesToSession(
    roomSession.id,
    [userMessage],
    payload.prompt,
    'Just now',
  );
  broadcastGroupTrace(ctx, roomSession.id, userMessage);

  const roomAfterUser = await findSession(roomSession.id);
  if (!isGroupRoomSession(roomAfterUser)) {
    throw new Error('Group session could not be reloaded after appending the user message.');
  }

  const snapshotSeq =
    roomAfterUser.messages.find((message) => message.id === userMessage.id)?.seq ??
    Math.max(
      0,
      ...roomAfterUser.messages
        .map((message) => (typeof message.seq === 'number' ? message.seq : 0)),
    );

  const targetParticipants = roomAfterUser.group.participants.filter((participant) =>
    targets.includes(participant.id),
  );
  const contextSnapshot = { ...roomAfterUser, messages: getRoomSnapshotMessages(roomAfterUser, snapshotSeq) };
  const placeholders = targetParticipants.map((participant) =>
    buildRoomAssistantPlaceholder(participant, participant.backingSessionId),
  );
  if (userMessage.teamDelivery) for (const placeholder of placeholders) placeholder.teamDelivery = { ...userMessage.teamDelivery };
  const queuedProjects =
    placeholders.length > 0
      ? await appendMessagesToSession(roomSession.id, placeholders, payload.prompt, 'Just now')
      : initialProjects;

  placeholders.forEach((placeholder, index) => {
    broadcastGroupTrace(
      ctx,
      roomSession.id,
      placeholder,
      targetParticipants[index]?.backingSessionId,
    );
  });

  // Broadcast running state for the room when participant turns start.
  const coordinator = coordinatorFor(state);
  const turn = coordinator.begin(roomSession.id);
  ctx.broadcastEvent({
    type: 'runtime-state',
    sessionId: roomSession.id,
    runtime: getGroupInteractionSnapshots(state)[roomSession.id].runtime!,
  });

  const turnPromises = targetParticipants.map((participant, index) => {
    const placeholder = placeholders[index];
    if (!placeholder) {
      return Promise.resolve();
    }

    const run = () => runGroupParticipantTurn(
      ctx,
      state,
      contextSnapshot,
      participant,
      placeholder,
      snapshotSeq,
      pendingAttachments,
      payload,
      turn.signal,
      taskContext,
    );
    const pending = coordinator.runMember(participant.backingSessionId, turn.signal, run);
    return pending.catch(async (error) => {
      if (turn.signal.aborted) return;
      await markGroupParticipantStartError(
        ctx,
        roomSession.id,
        participant,
        placeholder,
        error,
      );
    });
  });

  // When all participant turns settle, broadcast a full room snapshot so the
  // UI can recover if any fast participant events arrived before local state
  // had the group placeholder message.
  void Promise.allSettled(turnPromises).then(async () => {
    try {
      const latestRoom = await getSessionRecordForBootstrap(roomSession.id);
      if (latestRoom) {
        ctx.broadcastEvent({
          type: 'session-sync',
          sessionId: roomSession.id,
          session: latestRoom,
        });
      }
    } catch (error) {
      console.warn('[GROUP] Failed to broadcast final room snapshot', roomSession.id, error);
    }
    turn.finish();
    const pendingRuntime = getGroupInteractionSnapshots(state)[roomSession.id]?.runtime;
    ctx.broadcastEvent({
      type: 'runtime-state',
      sessionId: roomSession.id,
      runtime: pendingRuntime ?? { processActive: false, phase: 'inactive', pendingTurns: 0, updatedAt: Date.now() },
    });
    if (pendingRuntime) return;
    await Promise.allSettled([
      releaseMaterializedSessionHistory(roomSession.id),
      ...roomSession.group.participants.map((participant) =>
        releaseMaterializedSessionHistory(participant.backingSessionId),
      ),
    ]);
  });

  return {
    projects: queuedProjects,
    queued: {
      sessionId: roomSession.id,
      userMessageId: userMessage.id,
      assistantMessageId: placeholders[0]?.id ?? '',
    },
  };
};

const stopGroupParticipantRun = async (
  ctx: ClaudeInteractionContext,
  state: ClaudeInteractionState,
  participant: GroupParticipant,
  mode: 'stop' | 'disconnect',
) => {
  if (participant.provider === 'codex') {
    return mode === 'disconnect'
      ? disconnectCodexAppServerTurn(ctx, participant.backingSessionId)
      : interruptCodexAppServerTurn(ctx, participant.backingSessionId);
  }

  return mode === 'disconnect'
    ? disconnectSession(ctx, state, participant.backingSessionId)
    : interruptSessionTurn(ctx, state, participant.backingSessionId);
};

export const stopGroupSessionRuns = async (
  ctx: ClaudeInteractionContext,
  state: ClaudeInteractionState,
  sessionId: string,
  mode: 'stop' | 'disconnect' = 'stop',
) => coordinatorFor(state).dispatch(sessionId, () => stopGroupRuns(ctx, state, sessionId, mode));

const stopGroupRuns = async (
  ctx: ClaudeInteractionContext,
  state: ClaudeInteractionState,
  sessionId: string,
  mode: 'stop' | 'disconnect',
) => {
  const session = await findSession(sessionId);
  if (!isGroupRoomSession(session)) {
    throw new Error('Group session not found.');
  }

  const settled = coordinatorFor(state).cancel(sessionId);

  await Promise.allSettled(
    session.group.participants.map((participant) =>
      stopGroupParticipantRun(ctx, state, participant, mode),
    ),
  );

  await settled;
  const roomResult = await stopPendingSessionMessages(sessionId);
  roomResult.changedMessages.forEach((message) => {
    if (message.role === 'assistant') {
      ctx.broadcastEvent({
        type: 'status',
        sessionId,
        messageId: message.id,
        status: message.status,
        title: message.title,
        content: message.content,
      });
      return;
    }

    ctx.broadcastEvent({
      type: 'trace',
      sessionId,
      message,
    });
  });

  return {
    projects: roomResult.projects,
  };
};

export const getGroupSessionRuntimePhase = (
  session: SessionRecord | null | undefined,
): SessionRuntimePhase | null => {
  if (!isGroupRoomSession(session)) {
    return null;
  }

  return session.messages.some((message) => message.status === 'queued' || message.status === 'streaming' || message.status === 'running')
    ? 'running'
    : null;
};
