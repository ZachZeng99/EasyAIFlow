import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
let cached: { version: string; supported: boolean; checkedAt: number } | undefined;
let pending: Promise<boolean> | undefined;
export const supportsClaudeSubagentForwarding = async () => {
  if (cached && Date.now() - cached.checkedAt < 60000) return cached.supported;
  if (pending) return pending;
  pending = (async () => {
    try {
      const version = (await execute('claude', ['--version'], { windowsHide: true, timeout: 5000 })).stdout.trim();
      if (cached?.version === version) { cached.checkedAt = Date.now(); return cached.supported; }
      const help = (await execute('claude', ['--help'], { windowsHide: true, timeout: 5000 })).stdout;
      const supported = help.includes('--forward-subagent-text');
      cached = { version, supported, checkedAt: Date.now() };
      return supported;
    } catch { return false; }
  })().finally(() => { pending = undefined; });
  return pending;
};
