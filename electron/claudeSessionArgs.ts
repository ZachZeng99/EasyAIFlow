export const buildClaudeSessionArgs = (
  claudeSessionId: string | undefined,
  sessionTitle: string,
  forkSession = false,
) => {
  if (!claudeSessionId) {
    return ['-n', sessionTitle];
  }

  return forkSession
    ? ['--resume', claudeSessionId, '--fork-session']
    : ['--resume', claudeSessionId];
};
