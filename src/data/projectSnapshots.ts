import type { ProjectRecord, SessionRecord } from './types.js';

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
