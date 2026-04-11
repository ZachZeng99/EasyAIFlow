import type { SessionRecord } from '../src/data/types.js';
import { normalizeSessionProvider } from '../src/data/sessionProvider.js';

const buildTemporaryImportKey = (session: SessionRecord) =>
  `${normalizeSessionProvider(session.provider)}::${session.title.trim()}`;

export const pruneTemporaryImportedDuplicates = (sessions: SessionRecord[]) => {
  const grouped = new Map<string, SessionRecord[]>();

  sessions.forEach((session) => {
    if (session.sessionKind && session.sessionKind !== 'standard') {
      grouped.set(`__nonstandard__${session.id}`, [session]);
      return;
    }
    const key = buildTemporaryImportKey(session);
    const bucket = grouped.get(key) ?? [];
    bucket.push(session);
    grouped.set(key, bucket);
  });

  const kept = new Set<string>();
  const result: SessionRecord[] = [];

  for (const session of sessions) {
    if (session.sessionKind && session.sessionKind !== 'standard') {
      if (!kept.has(session.id)) {
        kept.add(session.id);
        result.push(session);
      }
      continue;
    }

    const key = buildTemporaryImportKey(session);
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
