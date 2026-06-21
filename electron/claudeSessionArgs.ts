export const buildClaudeSessionArgs = (
  claudeSessionId: string | undefined,
  sessionTitle: string,
  forkSession = false,
  newSessionId?: string,
) => {
  if (!claudeSessionId) {
    const args = ['-n', sessionTitle];
    if (newSessionId && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(newSessionId)) {
      args.push('--session-id', newSessionId);
    }
    return args;
  }

  return forkSession
    ? ['--resume', claudeSessionId, '--fork-session']
    : ['--resume', claudeSessionId];
};
