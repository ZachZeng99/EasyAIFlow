import { recoverStaleSessionMessages } from './sessionRecovery.js';
import type { ProjectRecord, SessionRecord } from '../src/data/types.js';

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
  mapProjects(projects, (session) => ({
    ...session,
    messages: session.messages ?? [],
  }));

export const normalizeProjectsFromPersistence = (projects: ProjectRecord[]) =>
  mapProjects(projects, (session) => ({
    ...session,
    messages: recoverStaleSessionMessages(session.messages),
    harnessState:
      session.harnessState?.status === 'running'
        ? { ...session.harnessState, status: 'failed' as const }
        : session.harnessState,
  }));
