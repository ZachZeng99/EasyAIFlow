import { randomUUID } from 'node:crypto';
import type { ClaudeInteractionContext } from './claudeInteractionContext.js';
import type { ClaudeInteractionState, ClaudePrintOptions, SessionBroadcastInterceptor } from './claudeInteractionState.js';
import { addSessionBroadcastInterceptor, removeSessionBroadcastInterceptor } from './claudeInteractionState.js';
import { buildMessageTitle, nowLabel } from './claudeHelpers.js';
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
  ensureGroupRoomBackingSessions,
  findSession,
  getProjects,
  updateAssistantMessage,
  updateSessionRecord,
  upsertSessionMessage,
} from '../electron/sessionStore.js';
import type {
  ClaudeStreamEvent,
  ConversationMessage,
  GroupParticipant,
  GroupParticipantId,
  PendingAttachment,
  SessionRecord,
  SessionRuntimePhase,
  SessionSummary,
} from '../src/data/types.js';
import { resolveGroupTargets } from '../src/data/groupChat.js';

type GroupSendPayload = {
  sessionId: string;
  prompt: string;
  attachments?: PendingAttachment[];
  session?: SessionSummary;
  model?: string;
  effort?: ClaudePrintOptions['effort'];
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

  return [
    `You are ${participant.label} in a shared chat room.`,
    `Write ${participant.label}'s next reply to TARGET_MESSAGE.`,
    '',
    'TARGET_MESSAGE:',
    addressedBlock,
    '',
    `ROOM_CONTEXT through message #${snapshotSeq}:`,
    `Participants: ${participantList}.`,
    syncLines,
    '',
    `Reply as ${participant.label}:`,
  ].join('\n');
};

const isGreetingOnly = (messages: ConversationMessage[]) => {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  if (!lastUser) return false;
  const cleaned = lastUser.content.replace(/@(?:claude|codex|all)\s*/gi, '').trim();
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

  const mirroredMessage: ConversationMessage = {
    ...message,
    id: buildMirroredTraceId(spec.roomSessionId, spec.participant.id, message.id),
    speakerId: spec.participant.id,
    speakerLabel: spec.participant.label,
    provider: spec.participant.provider,
    sourceSessionId: spec.backingSessionId,
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
  roomSession: SessionRecord,
  backingMessageId: string,
) => {
  const matchesBackingId =
    Boolean(spec.backingAssistantMessageId) && backingMessageId === spec.backingAssistantMessageId;

  if (spec.backingAssistantMessageId) {
    return matchesBackingId ? spec.roomAssistantMessageId : null;
  }

  const fallbackTarget = [...(roomSession.messages ?? [])]
    .reverse()
    .find(
      (message) =>
        message.role === 'assistant' &&
        message.speakerId === spec.participant.id &&
        message.sourceSessionId === spec.backingSessionId &&
        (message.status === 'queued' || message.status === 'streaming' || message.status === 'running'),
    );

  return fallbackTarget?.id ?? null;
};

const createMirroredContext = (
  ctx: ClaudeInteractionContext,
  spec: GroupMirrorSpec,
): ClaudeInteractionContext => {
  let mirrorQueue = Promise.resolve();

  return {
    ...ctx,
    broadcastEvent: (event) => {
      if (!('sessionId' in event)) {
        return;
      }
      if (event.sessionId !== spec.backingSessionId) {
        return;
      }

      // Serialize mirrored event processing to maintain delta ordering and
      // prevent concurrent read-modify-write races on the room session.
      mirrorQueue = mirrorQueue
        .then(async () => {
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
            event.type === 'background-task' ||
            event.type === 'runtime-state'
          ) {
            ctx.broadcastEvent({
              ...event,
              sessionId: spec.roomSessionId,
              sourceSessionId: spec.backingSessionId,
            });
          }
        })
        .catch((error) => {
          console.error(
            '[GROUP] Failed to mirror event',
            event.type,
            'for room session',
            spec.roomSessionId,
            'from backing session',
            spec.backingSessionId,
            error,
          );
        });
    },
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
  status: 'streaming',
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

const getRoomSnapshotMessages = (
  roomSession: SessionRecord,
  lastAppliedRoomSeq: number,
  snapshotSeq: number,
) =>
  (roomSession.messages ?? []).filter(
    (message) =>
      typeof message.seq === 'number' &&
      message.seq > lastAppliedRoomSeq &&
      message.seq <= snapshotSeq,
  );

const runGroupParticipantTurn = async (
  ctx: ClaudeInteractionContext,
  state: ClaudeInteractionState,
  roomSession: SessionRecord,
  participant: GroupParticipant,
  roomAssistantMessage: ConversationMessage,
  snapshotSeq: number,
  pendingAttachments: PendingAttachment[],
  payload: GroupSendPayload,
) => {
  const backingSession = await findSession(participant.backingSessionId);
  if (!backingSession) {
    throw new Error(`${participant.label} backing session not found.`);
  }

  const syncMessages = getRoomSnapshotMessages(roomSession, participant.lastAppliedRoomSeq, snapshotSeq);
  const syncPrompt = participant.provider === 'codex'
    ? buildCodexRoomChatPrompt(participant, syncMessages)
    : buildRoomSyncPrompt(roomSession, participant, syncMessages, snapshotSeq);
  const mirrorSpec: GroupMirrorSpec = {
    roomSessionId: roomSession.id,
    backingSessionId: backingSession.id,
    participant,
    roomAssistantMessageId: roomAssistantMessage.id,
  };
  const mirroredCtx = createMirroredContext(ctx, mirrorSpec);

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
        (event.type === 'complete' || event.type === 'error')
      ) {
        removeSessionBroadcastInterceptor(state, backingSession.id, interceptor!);
        interceptorSettled?.();
      }
    };

    addSessionBroadcastInterceptor(state, backingSession.id, interceptor);
  }

  try {
    // Codex: pass mirroredCtx directly — runCodexAppServerTurn is synchronous
    // and uses the passed ctx throughout, so mirroring works correctly.
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
              effort: payload.effort,
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
    if (backgroundSettled) {
      await backgroundSettled;
    }
  } finally {
    // Safety net: always clean up the interceptor even if the turn throws.
    if (interceptor) {
      removeSessionBroadcastInterceptor(state, backingSession.id, interceptor);
      interceptorSettled?.();
    }
  }
};

export const sendGroupMessage = async (
  ctx: ClaudeInteractionContext,
  state: ClaudeInteractionState,
  payload: GroupSendPayload,
) => {
  const roomSession =
    (await ensureGroupRoomBackingSessions(payload.sessionId).catch(() => null)) ??
    (payload.session ? await ensureGroupRoomBackingSessions(payload.session.id).catch(() => null) : null);
  if (!isGroupRoomSession(roomSession)) {
    throw new Error('Group session not found.');
  }

  const pendingAttachments = payload.attachments ?? [];
  const targets = resolveGroupTargets(
    payload.prompt,
    roomSession.group.participants,
    roomSession.messages ?? [],
  );
  const userMessage = buildRoomUserMessage(payload.prompt, targets, pendingAttachments);
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

  if (targets.length === 0) {
    return {
      projects: initialProjects,
      queued: {
        sessionId: roomSession.id,
        userMessageId: userMessage.id,
        assistantMessageId: '',
      },
    };
  }

  const targetParticipants = roomAfterUser.group.participants.filter((participant) =>
    targets.includes(participant.id),
  );
  const placeholders = targetParticipants.map((participant) =>
    buildRoomAssistantPlaceholder(participant, participant.backingSessionId),
  );
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
  ctx.broadcastEvent({
    type: 'runtime-state',
    sessionId: roomSession.id,
    runtime: { processActive: true, phase: 'running', updatedAt: Date.now() },
  });

  const turnPromises = targetParticipants.map((participant, index) => {
    const placeholder = placeholders[index];
    if (!placeholder) {
      return Promise.resolve();
    }

    return runGroupParticipantTurn(
      ctx,
      state,
      roomAfterUser,
      participant,
      placeholder,
      snapshotSeq,
      pendingAttachments,
      payload,
    ).catch(async (error) => {
      await markGroupParticipantStartError(
        ctx,
        roomSession.id,
        participant,
        placeholder,
        error,
      );
    });
  });

  // When all participant turns settle, broadcast inactive for the room.
  void Promise.allSettled(turnPromises).then(() => {
    ctx.broadcastEvent({
      type: 'runtime-state',
      sessionId: roomSession.id,
      runtime: { processActive: false, phase: 'inactive', updatedAt: Date.now() },
    });
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
) => {
  const session = await findSession(sessionId);
  if (!isGroupRoomSession(session)) {
    throw new Error('Group session not found.');
  }

  await Promise.allSettled(
    session.group.participants.map((participant) =>
      stopGroupParticipantRun(ctx, state, participant, mode),
    ),
  );

  return {
    projects: await getProjects(),
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
