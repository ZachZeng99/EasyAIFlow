import type { ProjectRecord, SessionSummary } from './types.js';

export const sortSessionsWithPinnedFirst = <
  T extends Pick<SessionSummary, 'pinned' | 'updatedAt'>,
>(sessions: readonly T[]) =>
  [...sessions].sort((left, right) => {
    const pinDifference = Number(Boolean(right.pinned)) - Number(Boolean(left.pinned));
    return pinDifference || (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
  });

export const collectPinnedSessions = (projects: readonly ProjectRecord[]) =>
  sortSessionsWithPinnedFirst(
    projects.flatMap((project) =>
      project.dreams.flatMap((dream) =>
        dream.sessions.filter((session) => session.pinned && !session.hidden),
      ),
    ),
  );
