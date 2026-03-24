type ClaudeSpawnOptions = {
  cwd: string;
  windowsHide: true;
  stdio: ['pipe', 'pipe', 'pipe'];
};

export const getClaudeSpawnOptions = (cwd: string): ClaudeSpawnOptions => ({
  cwd,
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
});
