import type { ConversationMessage, ProjectRecord, SessionRecord } from './types.js';

const getMessageStatusRank = (status: ConversationMessage['status']) => {
  switch (status) {
    case 'complete':
    case 'error':
      return 4;
    case 'success':
      return 3;
    case 'streaming':
    case 'running':
    case 'background':
      return 2;
    case 'queued':
      return 1;
    default:
      return 0;
  }
};

const shouldUseIncomingMessageBody = (
  existingMessage: ConversationMessage,
  incomingMessage: ConversationMessage,
) => {
  const existingRank = getMessageStatusRank(existingMessage.status);
  const incomingRank = getMessageStatusRank(incomingMessage.status);

  return (
    incomingRank > existingRank ||
    (!existingMessage.content && Boolean(incomingMessage.content))
  );
};

const mergeStaleGroupMessage = (
  existingMessage: ConversationMessage,
  incomingMessage: ConversationMessage,
): ConversationMessage => {
  const bodySource = shouldUseIncomingMessageBody(existingMessage, incomingMessage)
    ? incomingMessage
    : existingMessage;

  return {
    ...incomingMessage,
    ...existingMessage,
    title: bodySource.title,
    content: bodySource.content,
    status: bodySource.status,
    kind: existingMessage.kind ?? incomingMessage.kind,
    seq: existingMessage.seq ?? incomingMessage.seq,
    speakerId: existingMessage.speakerId ?? incomingMessage.speakerId,
    speakerLabel: existingMessage.speakerLabel ?? incomingMessage.speakerLabel,
    provider: existingMessage.provider ?? incomingMessage.provider,
    sourceSessionId: existingMessage.sourceSessionId ?? incomingMessage.sourceSessionId,
    targetParticipantIds: existingMessage.targetParticipantIds ?? incomingMessage.targetParticipantIds,
    contextReferences: existingMessage.contextReferences ?? incomingMessage.contextReferences,
    attachments: existingMessage.attachments ?? incomingMessage.attachments,
    recordedDiff: existingMessage.recordedDiff ?? incomingMessage.recordedDiff,
    steps: existingMessage.steps ?? incomingMessage.steps,
  };
};

const getMessageSeq = (message: ConversationMessage) =>
  typeof message.seq === 'number' ? message.seq : undefined;

const mergeStaleGroupMessages = (
  existingMessages: ConversationMessage[],
  incomingMessages: ConversationMessage[],
) => {
  const incomingById = new Map(incomingMessages.map((message) => [message.id, message] as const));
  const highestExistingSeq = Math.max(
    0,
    ...existingMessages.map((message) => getMessageSeq(message) ?? 0),
  );
  const mergedById = new Map<string, ConversationMessage>();

  existingMessages.forEach((message) => {
    const incoming = incomingById.get(message.id);
    mergedById.set(message.id, incoming ? mergeStaleGroupMessage(message, incoming) : message);
  });

  incomingMessages.forEach((message) => {
    if (mergedById.has(message.id)) {
      return;
    }

    const seq = getMessageSeq(message);
    if (seq !== undefined && seq > highestExistingSeq) {
      mergedById.set(message.id, message);
    }
  });

  const originalOrder = new Map<string, number>();
  [...existingMessages, ...incomingMessages].forEach((message, index) => {
    if (!originalOrder.has(message.id)) {
      originalOrder.set(message.id, index);
    }
  });

  return [...mergedById.values()].sort((left, right) => {
    const leftSeq = getMessageSeq(left);
    const rightSeq = getMessageSeq(right);
    if (leftSeq !== undefined && rightSeq !== undefined && leftSeq !== rightSeq) {
      return leftSeq - rightSeq;
    }
    if (leftSeq !== undefined && rightSeq === undefined) {
      return -1;
    }
    if (leftSeq === undefined && rightSeq !== undefined) {
      return 1;
    }

    return (originalOrder.get(left.id) ?? 0) - (originalOrder.get(right.id) ?? 0);
  });
};

const shouldMergeStaleGroupSnapshot = (
  incomingSession: SessionRecord,
) =>
  incomingSession.sessionKind === 'group' &&
  incomingSession.group?.kind === 'room' &&
  incomingSession.messages.some((message) => getMessageSeq(message) !== undefined);

const mergeStaleGroupSnapshot = (
  existingSession: SessionRecord,
  incomingSession: SessionRecord,
): SessionRecord => {
  const messages = mergeStaleGroupMessages(
    existingSession.messages ?? [],
    incomingSession.messages ?? [],
  );

  return {
    ...existingSession,
    provider: incomingSession.provider,
    model: incomingSession.model,
    claudeSessionId: incomingSession.claudeSessionId,
    codexThreadId: incomingSession.codexThreadId,
    sessionKind: incomingSession.sessionKind,
    hidden: incomingSession.hidden,
    instructionPrompt: incomingSession.instructionPrompt,
    group: incomingSession.group,
    contextReferences: incomingSession.contextReferences,
    messagesLoaded: incomingSession.messagesLoaded ?? existingSession.messagesLoaded,
    preview: existingSession.preview || incomingSession.preview,
    timeLabel: existingSession.timeLabel || incomingSession.timeLabel,
    messages,
  };
};

export const mergeSessionSnapshot = (
  existingSession: SessionRecord | undefined,
  incomingSession: SessionRecord,
): SessionRecord => {
  if (!existingSession) {
    return incomingSession;
  }

  if (incomingSession.messagesLoaded === false) {
    if (existingSession.messagesLoaded === false) {
      return incomingSession;
    }

    return {
      ...incomingSession,
      messages: existingSession.messages ?? [],
      messagesLoaded: existingSession.messagesLoaded,
    };
  }

  if (existingSession.messagesLoaded === false) {
    return incomingSession;
  }

  const existingUpdatedAt = existingSession.updatedAt ?? 0;
  const incomingUpdatedAt = incomingSession.updatedAt ?? 0;

  if (incomingUpdatedAt < existingUpdatedAt) {
    if (shouldMergeStaleGroupSnapshot(incomingSession)) {
      return mergeStaleGroupSnapshot(existingSession, incomingSession);
    }

    return existingSession;
  }

  return incomingSession;
};

export const mergeProjectSnapshots = (
  currentProjects: ProjectRecord[],
  nextProjects: ProjectRecord[],
) => {
  const currentSessions = new Map(
    currentProjects
      .flatMap((project) =>
        project.dreams.flatMap((dream) => dream.sessions.map((session) => session as SessionRecord)),
      )
      .map((session) => [session.id, session]),
  );

  return nextProjects.map((project) => ({
    ...project,
    dreams: project.dreams.map((dream) => ({
      ...dream,
      sessions: dream.sessions.map((session) =>
        mergeSessionSnapshot(currentSessions.get(session.id), session as SessionRecord),
      ),
    })),
  }));
};

export const hydrateSessionRecordInProjects = (
  projects: ProjectRecord[],
  sessionRecord: SessionRecord,
) => {
  const hydratedSession = {
    ...sessionRecord,
    messagesLoaded: true,
  };
  let found = false;

  const nextProjects = projects.map((project) => ({
    ...project,
    dreams: project.dreams.map((dream) => ({
      ...dream,
      sessions: dream.sessions.map((session) => {
        if (session.id !== sessionRecord.id) {
          return session;
        }

        found = true;
        return mergeSessionSnapshot(session as SessionRecord, hydratedSession);
      }),
    })),
  }));

  if (found) {
    return nextProjects;
  }

  return nextProjects.map((project) =>
    project.id !== sessionRecord.projectId
      ? project
      : {
          ...project,
          dreams: project.dreams.map((dream) =>
            dream.id !== sessionRecord.dreamId
              ? dream
              : {
                  ...dream,
                  sessions: [hydratedSession, ...dream.sessions],
                },
          ),
        },
  );
};

export const mergeProjectSnapshotsAndHydrateSession = (
  currentProjects: ProjectRecord[],
  nextProjects: ProjectRecord[],
  sessionRecord: SessionRecord,
) => hydrateSessionRecordInProjects(
  mergeProjectSnapshots(currentProjects, nextProjects),
  sessionRecord,
);
