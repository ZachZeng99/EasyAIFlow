import { normalizeSessionProvider } from '../src/data/sessionProvider.js';
import { recoverStaleGroupRoomMessages, recoverStaleSessionMessagesForProvider } from './sessionRecovery.js';
import type { ProjectRecord, SessionRecord } from '../src/data/types.js';

const inferSessionKind = (session: SessionRecord) => {
  if (session.group?.kind === 'room') {
    return 'group' as const;
  }

  if (session.group?.kind === 'member') {
    return 'group_member' as const;
  }

  return session.sessionKind === 'group' || session.sessionKind === 'group_member'
    ? session.sessionKind
    : 'standard';
};

const mapProjects = (
  projects: ProjectRecord[],
  mapSession: (session: SessionRecord) => SessionRecord,
) =>
  projects.map((project) => ({
    ...project,
    dreams: project.dreams.map((dream) => ({
      ...dream,
      sessions: dream.sessions.map((session) => mapSession(session as SessionRecord)),
    })),
  }));

const isPendingAssistantStatus = (status: SessionRecord['messages'][number]['status']) =>
  status === 'queued' || status === 'streaming' || status === 'running' || status === 'background';

const canBeRehydratedFromBackingSession = (message: SessionRecord['messages'][number]) =>
  isPendingAssistantStatus(message.status) ||
  (
    message.status === 'error' &&
    (
      message.content.startsWith('Previous ') ||
      message.content.startsWith('Queued ')
    )
  );

const rehydrateGroupRoomMessagesFromBackingSessions = (projects: ProjectRecord[]) => {
  const sessionsById = new Map<string, SessionRecord>();
  projects.forEach((project) => {
    project.dreams.forEach((dream) => {
      dream.sessions.forEach((session) => {
        sessionsById.set(session.id, session as SessionRecord);
      });
    });
  });

  return projects.map((project) => ({
    ...project,
    dreams: project.dreams.map((dream) => ({
      ...dream,
      sessions: dream.sessions.map((session) => {
        const typedSession = session as SessionRecord;
        if (typedSession.sessionKind !== 'group' || typedSession.group?.kind !== 'room') {
          return typedSession;
        }

        return {
          ...typedSession,
          messages: (typedSession.messages ?? []).map((message) => {
            if (
              message.role !== 'assistant' ||
              !message.sourceSessionId ||
              !canBeRehydratedFromBackingSession(message)
            ) {
              return message;
            }

            const backingSession = sessionsById.get(message.sourceSessionId);
            const backingAssistant = [...(backingSession?.messages ?? [])]
              .reverse()
              .find(
                (candidate) =>
                  candidate.role === 'assistant' && !isPendingAssistantStatus(candidate.status),
              );

            if (!backingAssistant) {
              return message;
            }

            return {
              ...message,
              title: backingAssistant.title,
              content: backingAssistant.content,
              status: backingAssistant.status,
              timestamp: backingAssistant.timestamp,
              provider: message.provider ?? backingAssistant.provider,
            };
          }),
        };
      }),
    })),
  }));
};

export const normalizeProjectsForCache = (projects: ProjectRecord[]) =>
  mapProjects(projects, (session) => {
    const sessionKind = inferSessionKind(session);
    return {
      ...session,
      sessionKind,
      hidden: sessionKind === 'group_member' ? true : Boolean(session.hidden),
      provider: sessionKind === 'group' ? undefined : normalizeSessionProvider(session.provider),
      messages: session.messages ?? [],
    };
  });

export const normalizeProjectsFromPersistence = (projects: ProjectRecord[]) =>
  rehydrateGroupRoomMessagesFromBackingSessions(
    mapProjects(projects, (session) => {
      const sessionKind = inferSessionKind(session);
      const provider = sessionKind === 'group' ? undefined : normalizeSessionProvider(session.provider);
      return {
        ...session,
        sessionKind,
        hidden: sessionKind === 'group_member' ? true : Boolean(session.hidden),
        provider,
        messages:
          sessionKind === 'group'
            ? recoverStaleGroupRoomMessages(session.messages)
            : recoverStaleSessionMessagesForProvider(session.messages, provider),
      };
    }),
  );
