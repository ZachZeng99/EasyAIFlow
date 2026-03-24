import type { SessionRecord } from '../src/data/types.js';

export const pruneTemporaryImportedDuplicates = (sessions: SessionRecord[]) => {
  const grouped = new Map<string, SessionRecord[]>();

  sessions.forEach((session) => {
    const key = session.title.trim();
    const bucket = grouped.get(key) ?? [];
    bucket.push(session);
    grouped.set(key, bucket);
  });

  const kept = new Set<string>();
  const result: SessionRecord[] = [];

  for (const session of sessions) {
    const key = session.title.trim();
    if (kept.has(session.id)) {
      continue;
    }

    const bucket = grouped.get(key) ?? [session];
    const positiveUsage = bucket.filter((item) => (item.tokenUsage?.used ?? 0) > 0);

    if (bucket.length > 1 && positiveUsage.length === 1) {
      const winner = positiveUsage[0];
      if (!kept.has(winner.id)) {
        kept.add(winner.id);
        result.push(winner);
      }
      continue;
    }

    kept.add(session.id);
    result.push(session);
  }

  return result;
};
