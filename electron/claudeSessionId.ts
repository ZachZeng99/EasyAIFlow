export const extractClaudeSessionId = (parsed: Record<string, unknown>) => {
  const sessionId =
    (typeof parsed.session_id === 'string' && parsed.session_id.trim()) ||
    (typeof parsed.sessionId === 'string' && parsed.sessionId.trim()) ||
    undefined;

  return sessionId;
};
