import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export type CodexRuntimeCandidate = {
  path: string;
  command: string;
  prefixArgs: string[];
  source: 'path' | 'desktop' | 'override';
};
export type CodexRuntime = CodexRuntimeCandidate & { version: string; identity: string };

const exists = async (filename: string) => {
  try { return (await stat(filename)).isFile(); } catch { return false; }
};

export const discoverCodexRuntimes = async (): Promise<CodexRuntimeCandidate[]> => {
  const candidates = new Map<string, CodexRuntimeCandidate>();
  const add = async (filename: string, source: CodexRuntimeCandidate['source']) => {
    if (!await exists(filename)) return;
    const fullPath = path.resolve(filename);
    const key = process.platform === 'win32' ? fullPath.toLowerCase() : fullPath;
    candidates.set(key, { path: fullPath, source,
      command: fullPath.endsWith('.js') ? process.execPath : fullPath,
      prefixArgs: fullPath.endsWith('.js') ? [fullPath] : [],
    });
  };
  const override = process.env.EASYAIFLOW_CODEX_PATH?.trim();
  if (override) {
    if (!path.isAbsolute(override) || /\.(cmd|bat|ps1)$/i.test(override)) {
      throw new Error('EASYAIFLOW_CODEX_PATH must be an absolute codex executable or codex.js path.');
    }
    await add(override, 'override');
    if (!candidates.size) throw new Error(`Configured Codex executable does not exist: ${override}`);
    return [...candidates.values()];
  }
  const directories = [...new Set((process.env.PATH ?? '').split(path.delimiter).map((item) => item.replace(/^"|"$/g, '')).filter((item) => path.isAbsolute(item)))];
  await Promise.all(directories.map(async (directory) => {
    await add(path.join(directory, process.platform === 'win32' ? 'codex.exe' : 'codex'), 'path');
    if (process.platform === 'win32' && await exists(path.join(directory, 'codex.cmd'))) {
      // Launch the npm entry directly through Node, so prompts never pass through cmd parsing.
      await add(path.join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), 'path');
    }
  }));
  if (process.platform === 'win32') {
    const root = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin');
    try {
      const directories = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory());
      await Promise.all(directories.map((entry) => add(path.join(root, entry.name, 'codex.exe'), 'desktop')));
    } catch { /* Desktop installation is optional. PATH installations still work. */ }
  }
  return [...candidates.values()];
};

const parts = (version: string) => version.replace(/^codex-cli\s+/, '').split('+')[0].split(/[.-]/).map((value) => /^\d+$/.test(value) ? Number(value) : value);
export const compareCodexVersions = (left: string, right: string) => {
  const a = parts(left);
  const b = parts(right);
  for (let i = 0; i < 3; i++) {
    const difference = Number(a[i] ?? 0) - Number(b[i] ?? 0);
    if (difference) return difference;
  }
  if (a.length === 3 || b.length === 3) return a.length === b.length ? 0 : a.length === 3 ? 1 : -1;
  for (let i = 3; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    if (typeof a[i] === 'number' && typeof b[i] === 'number') return Number(a[i]) - Number(b[i]);
    if (typeof a[i] !== typeof b[i]) return typeof a[i] === 'number' ? -1 : 1;
    return String(a[i]).localeCompare(String(b[i]));
  }
  return 0;
};

const probeRuntime = async (candidate: CodexRuntimeCandidate) => {
  const result = await execFileAsync(candidate.command, [...candidate.prefixArgs, '--version'], {
    windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024,
  });
  const version = result.stdout.trim();
  if (!/^codex-cli\s+\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) throw new Error('Unrecognized Codex version response.');
  return version;
};

export class CodexRuntimeResolver {
  private cached?: { key: string; at: number; runtime: CodexRuntime };
  private pending?: { key: string; value: Promise<CodexRuntime> };
  constructor(private readonly dependencies = { discover: discoverCodexRuntimes, probe: probeRuntime, now: Date.now }) {}

  async resolve(force = false): Promise<CodexRuntime> {
    const key = JSON.stringify([process.env.PATH, process.env.LOCALAPPDATA, process.env.EASYAIFLOW_CODEX_PATH]);
    const now = this.dependencies.now();
    if (!force && this.cached?.key === key && now - this.cached.at < 30000) return this.cached.runtime;
    if (this.pending?.key === key) return this.pending.value;
    const value = (async () => {
      const candidates = await this.dependencies.discover();
      const discovered: CodexRuntime[] = [];
      // Limit concurrent probes even when several old desktop installations remain.
      for (let index = 0; index < candidates.length; index += 4) {
        await Promise.all(candidates.slice(index, index + 4).map(async (candidate) => {
          try {
            const version = await this.dependencies.probe(candidate);
            discovered.push({ ...candidate, version, identity: JSON.stringify([candidate.path, version]) });
          } catch (error) {
            if (candidate.source === 'override') throw error;
          }
        }));
      }
      discovered.sort((a, b) => compareCodexVersions(b.version, a.version) || a.path.localeCompare(b.path));
      const runtime = discovered[0];
      if (!runtime) throw new Error('No working Codex runtime was found. Install Codex or set EASYAIFLOW_CODEX_PATH.');
      this.cached = { key, at: this.dependencies.now(), runtime };
      return runtime;
    })().finally(() => { if (this.pending?.value === value) this.pending = undefined; });
    this.pending = { key, value };
    return value;
  }
}

export const codexRuntimeResolver = new CodexRuntimeResolver();
export const codexRuntimeSpawnSpec = (runtime: CodexRuntime, args: string[]) => ({
  command: runtime.command, args: [...runtime.prefixArgs, ...args], shell: false as const,
});
