import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Claude CLI registers every top-level process in
 * `<CLAUDE_CONFIG_DIR | ~/.claude>/sessions/<pid>.json` (see
 * claude-code utils/concurrentSessions.ts). The `name` field is the agent name
 * peers use to address the session (e.g. `easyaiflow-58`); it may be patched
 * after startup, so callers poll until it appears.
 */
export const getClaudeSessionRegistryPath = (
  pid: number,
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
) => path.join(env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude'), 'sessions', `${pid}.json`);

export const parseClaudeAgentName = (raw: string): string | undefined => {
  try {
    const data = JSON.parse(raw) as { name?: unknown };
    return typeof data.name === 'string' && data.name.trim() ? data.name.trim() : undefined;
  } catch {
    return undefined;
  }
};

export const readClaudeAgentName = async (pid: number, filePath = getClaudeSessionRegistryPath(pid)) => {
  try {
    return parseClaudeAgentName(await readFile(filePath, 'utf8'));
  } catch {
    return undefined;
  }
};

export const pollClaudeAgentName = async (
  pid: number,
  options: {
    isAlive: () => boolean;
    intervalMs?: number;
    timeoutMs?: number;
    read?: (pid: number) => Promise<string | undefined>;
  },
) => {
  const intervalMs = options.intervalMs ?? 500;
  const deadline = Date.now() + (options.timeoutMs ?? 20_000);
  const read = options.read ?? readClaudeAgentName;
  while (options.isAlive()) {
    const name = await read(pid);
    if (name) {
      return name;
    }
    if (Date.now() >= deadline) {
      return undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return undefined;
};
