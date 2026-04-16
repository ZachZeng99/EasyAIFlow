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
  });
