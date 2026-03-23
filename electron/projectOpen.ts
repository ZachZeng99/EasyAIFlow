import type { ProjectRecord, SessionRecord } from '../src/data/types.js';

export const hydrateProjectForOpen = async (
  project: ProjectRecord,
  importNativeSessions: (project: ProjectRecord) => Promise<void>,
  ensureProjectSession: (project: ProjectRecord) => SessionRecord,
) => {
  await importNativeSessions(project);
  return ensureProjectSession(project);
};
