export const buildClaudeSessionArgs = (claudeSessionId: string | undefined, sessionTitle: string) => {
  if (!claudeSessionId) {
    return ['-n', sessionTitle];
  }

  return ['--resume', claudeSessionId];
};
