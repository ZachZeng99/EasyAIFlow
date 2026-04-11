import type { DreamRecord, ProjectRecord, SessionRecord } from '../src/data/types.js';
import { normalizeSessionProvider } from '../src/data/sessionProvider.js';
import { pruneTemporaryImportedDuplicates } from './importedSessionCleanup.js';

const buildSessionTitleKey = (session: SessionRecord) =>
  `${normalizeSessionProvider(session.provider)}::${session.title.trim()}`;

const choosePreferredSession = (current: SessionRecord | undefined, candidate: SessionRecord, dream: DreamRecord) => {
  if (!current) {
    return candidate;
  }

  const currentTemporary = current.dreamName === 'Temporary';
  const candidateTemporary = dream.isTemporary || dream.name === 'Temporary';

  if (currentTemporary && !candidateTemporary) {
    return candidate;
  }
  if (!currentTemporary && candidateTemporary) {
    return current;
  }

  return (candidate.updatedAt ?? 0) > (current.updatedAt ?? 0) ? candidate : current;
};

export const cleanupProjectSessions = (project: ProjectRecord) => {
  const preferredById = new Map<string, SessionRecord>();
  const preferredByTitle = new Map<string, SessionRecord>();

  project.dreams.forEach((dream) => {
    dream.sessions.forEach((session) => {
      preferredById.set(session.id, choosePreferredSession(preferredById.get(session.id) as SessionRecord | undefined, session as SessionRecord, dream));

      if ((session as SessionRecord).sessionKind && (session as SessionRecord).sessionKind !== 'standard') {
        return;
      }

      const titleKey = buildSessionTitleKey(session as SessionRecord);
      const current = preferredByTitle.get(titleKey);
      const candidate = session as SessionRecord;
      const currentTemporary = current?.dreamName === 'Temporary';
      const candidateTemporary = dream.isTemporary || dream.name === 'Temporary';

      if (!current) {
        preferredByTitle.set(titleKey, candidate);
      } else if (currentTemporary && !candidateTemporary) {
        preferredByTitle.set(titleKey, candidate);
      } else if (!currentTemporary && candidateTemporary) {
        // Keep existing non-temporary target.
      } else if ((candidate.updatedAt ?? 0) > (current.updatedAt ?? 0)) {
        preferredByTitle.set(titleKey, candidate);
      }
    });
  });

  project.dreams = project.dreams.map((dream) => {
    const filtered = dream.sessions
      .filter((session) => preferredById.get(session.id) === session)
      .filter((session) => {
        if ((session as SessionRecord).sessionKind && (session as SessionRecord).sessionKind !== 'standard') {
          return true;
        }

        const preferred = preferredByTitle.get(buildSessionTitleKey(session as SessionRecord));
        if (!preferred) {
          return true;
        }

        if (buildSessionTitleKey(session as SessionRecord) !== buildSessionTitleKey(preferred)) {
          return true;
        }

        if (session.dreamName === preferred.dreamName) {
          return session.id === preferred.id || buildSessionTitleKey(session as SessionRecord) !== buildSessionTitleKey(preferred);
        }

        return session.dreamName !== 'Temporary';
      });
    const normalized = (dream.isTemporary ? pruneTemporaryImportedDuplicates(filtered as SessionRecord[]) : filtered) as SessionRecord[];
    return {
      ...dream,
      sessions: normalized,
    };
  });

  return project;
};
