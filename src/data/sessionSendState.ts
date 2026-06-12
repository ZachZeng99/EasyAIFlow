export const isSessionSending = (
  sendingSessionIds: readonly string[],
  sessionId: string | null | undefined,
) => Boolean(sessionId && sendingSessionIds.includes(sessionId));

export const markSessionSending = (
  sendingSessionIds: string[],
  sessionId: string,
): string[] => {
  if (!sessionId || sendingSessionIds.includes(sessionId)) {
    return sendingSessionIds;
  }

  return [...sendingSessionIds, sessionId];
};

export const clearSessionSending = (
  sendingSessionIds: string[],
  sessionId: string,
): string[] => {
  if (!sessionId || !sendingSessionIds.includes(sessionId)) {
    return sendingSessionIds;
  }

  return sendingSessionIds.filter((currentSessionId) => currentSessionId !== sessionId);
};
