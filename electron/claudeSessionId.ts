export const extractClaudeSessionId = (parsed: Record<string, unknown>) => {
  const sessionId =
    (typeof parsed.session_id === 'string' && parsed.session_id.trim()) ||
    (typeof parsed.sessionId === 'string' && parsed.sessionId.trim()) ||
    undefined;

  return sessionId;
};

export const applyParsedSessionMetadata = <
  T extends {
    claudeSessionId?: string;
    model?: string;
  },
>(
  state: T,
  parsed: Record<string, unknown>,
): T => {
  const next = { ...state };
  const sessionId = extractClaudeSessionId(parsed);
  if (sessionId) {
    next.claudeSessionId = sessionId;
  }

  if (parsed.type === 'assistant') {
    const message = parsed.message as { model?: unknown } | undefined;
    if (typeof message?.model === 'string' && message.model.trim()) {
      next.model = message.model.trim();
    }
  }

  if (
    parsed.type === 'system' &&
    parsed.subtype === 'init' &&
    typeof parsed.model === 'string' &&
    parsed.model.trim()
  ) {
    next.model = parsed.model.trim();
  }

  return next;
};
