import type { SessionRecord } from '../src/data/types.js';

const isGeneratedPlaceholder = (session: SessionRecord) =>
  !session.claudeSessionId &&
  /^New Session \d+$/.test(session.title) &&
  session.preview === 'Start a new Claude conversation.' &&
  (session.messages?.length ?? 0) === 0;

const isStaleImportedPlaceholder = (session: SessionRecord) =>
  Boolean(session.claudeSessionId) &&
  /^Imported [0-9a-f]{8}$/i.test(session.title.trim()) &&
  session.preview === 'Imported Claude history.' &&
  (session.messages?.length ?? 0) === 0;

export const mergeNativeImportedSessions = (
  existingSessions: SessionRecord[],
  importedSessions: SessionRecord[],
  seenNativeIds: Set<string>,
) => {
  const preservedLocalSessions =
    importedSessions.length > 0
      ? existingSessions.filter((session) => !session.claudeSessionId && !isGeneratedPlaceholder(session))
      : existingSessions.filter((session) => !session.claudeSessionId);

  const preservedRemoteSessions = existingSessions.filter(
    (session): session is SessionRecord & { claudeSessionId: string } =>
      Boolean(session.claudeSessionId),
  );

  return [
    ...preservedLocalSessions,
    ...preservedRemoteSessions.filter(
      (session) =>
        !seenNativeIds.has(session.claudeSessionId) &&
        !isStaleImportedPlaceholder(session),
    ),
    ...importedSessions,
  ].sort(
    (left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0),
  );
};
