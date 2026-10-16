import { spawn, execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { CodexAppServerClient } from './codexAppServer.js';
import { getClaudeSpawnOptions } from '../electron/claudeSpawn.js';
import { normalizeProviderModels, type ProviderModel, type ProviderModelCatalog } from '../src/data/providerModels.js';
import type { SessionProvider } from '../src/data/types.js';

const execFileAsync = promisify(execFile);
const TTL_MS = 15 * 60 * 1000;

type RuntimeModelCatalog = { models: ProviderModel[]; commands?: string[] };

export const queryRuntimeCatalog = async (provider: SessionProvider, cwd: string): Promise<RuntimeModelCatalog> => {
  if (provider === 'codex') {
    let client: CodexAppServerClient | undefined;
    let timeout: ReturnType<typeof setTimeout>;
    try {
      const response = await Promise.race([
        (async () => {
          client = await CodexAppServerClient.create(cwd, { timeoutMs: 15000 });
          const models: unknown[] = [];
          let cursor: string | undefined;
          do {
            const page = await client.request<{ data: unknown[]; nextCursor?: string | null }>('model/list', { limit: 100, cursor });
            models.push(...page.data);
            cursor = page.nextCursor ?? undefined;
          } while (cursor && models.length < 1000);
          return models;
        })(),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Codex model discovery timed out.')), 15000); }),
      ]);
      return { models: normalizeProviderModels(provider, response) };
    } finally { clearTimeout(timeout!); await client?.close(); }
  }
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const child = spawn('claude', ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence'], getClaudeSpawnOptions(cwd));
    const reader = createInterface({ input: child.stdout! });
    let settled = false;
    let bytes = 0;
    const finish = (catalog?: RuntimeModelCatalog, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reader.close();
      child.stdin?.end();
      child.kill();
      if (error) reject(error); else resolve(catalog ?? { models: [] });
    };
    const timer = setTimeout(() => finish(undefined, new Error('Claude model discovery timed out.')), 15000);
    child.on('error', (error) => finish(undefined, error));
    child.stdin?.on('error', (error) => finish(undefined, error));
    child.on('close', () => { if (!settled) finish(undefined, new Error('Claude did not return a model catalog. Check CLI compatibility.')); });
    child.stderr?.resume();
    reader.on('line', (line) => {
      bytes += Buffer.byteLength(line);
      if (bytes > 4 * 1024 * 1024) { finish(undefined, new Error('Claude initialization exceeded the response limit.')); return; }
      try {
        const frame = JSON.parse(line);
        if (frame.type !== 'control_response' || frame.response?.request_id !== id) return;
        if (frame.response.subtype === 'error') finish(undefined, new Error(String(frame.response.error ?? 'Claude initialization failed.')));
        else {
          const initialized = frame.response.response;
          const commands = Array.isArray(initialized?.commands)
            ? initialized.commands.map((command: unknown) => {
              const name = typeof command === 'string' ? command : command && typeof command === 'object' ? (command as { name?: unknown }).name : undefined;
              return typeof name === 'string' ? name.trim().replace(/^\//, '') : '';
            }).filter(Boolean)
            : [];
          finish({ models: normalizeProviderModels('claude', initialized?.models), commands });
        }
      } catch { /* Non-JSON diagnostics are not protocol messages. */ }
    });
    child.stdin?.end(`${JSON.stringify({ type: 'control_request', request_id: id, request: { subtype: 'initialize' } })}\n`);
  });
};

export const queryRuntimeModels = async (provider: SessionProvider, cwd: string) => (await queryRuntimeCatalog(provider, cwd)).models;

export const readProviderVersion = async (provider: SessionProvider, cwd: string) => {
  const windowsCodex = provider === 'codex' && process.platform === 'win32';
  try {
    const version = await execFileAsync(windowsCodex ? process.env.ComSpec || 'cmd.exe' : provider,
      windowsCodex ? ['/d', '/s', '/c', 'codex', '--version'] : ['--version'], { cwd, windowsHide: true, timeout: 5000 });
    return version.stdout.trim();
  } catch { return undefined; }
};

export const runtimeModelScope = async (provider: SessionProvider, cwd: string, home: string) => {
  const files = provider === 'claude'
    ? [path.join(home, '.claude', '.credentials.json'), path.join(home, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json')]
    : [path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'auth.json'), path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'config.toml')];
  const signatures = await Promise.all(files.map(async (file) => {
    try { const value = await stat(file); return `${file}:${value.mtimeMs}:${value.size}`; } catch { return `${file}:missing`; }
  }));
  // Secrets influence isolation, but are never persisted or returned to clients.
  const environment = provider === 'claude'
    ? [process.env.ANTHROPIC_API_KEY, process.env.ANTHROPIC_AUTH_TOKEN, process.env.ANTHROPIC_BASE_URL]
    : [process.env.OPENAI_API_KEY, process.env.OPENAI_BASE_URL, process.env.CODEX_HOME];
  return createHash('sha256').update(JSON.stringify([signatures, environment])).digest('hex');
};

export class ProviderModelCatalogStore {
  private readonly cache = new Map<string, ProviderModelCatalog>();
  private readonly pending = new Map<string, Promise<ProviderModelCatalog>>();
  constructor(private readonly directory: string, private readonly options: {
    load: (provider: SessionProvider, cwd: string) => Promise<RuntimeModelCatalog | ProviderModel[]>;
    scope: (provider: SessionProvider, cwd: string) => Promise<string>;
    now?: () => number;
    version?: typeof readProviderVersion;
  }) {}

  async get(provider: SessionProvider, cwd: string, force = false): Promise<ProviderModelCatalog> {
    const scope = await this.options.scope(provider, cwd);
    const runtimeVersion = await this.options.version?.(provider, cwd);
    const key = createHash('sha256').update(JSON.stringify([provider, path.resolve(cwd), scope])).digest('hex');
    const filename = path.join(this.directory, `${key}.json`);
    let cached = this.cache.get(key);
    if (!cached) {
      try {
        const parsed = JSON.parse(await readFile(filename, 'utf8')) as ProviderModelCatalog;
        if (parsed.provider === provider && Array.isArray(parsed.models) && parsed.models.every((model) =>
          model && typeof model.id === 'string' && typeof model.label === 'string' &&
          (model.supportedEfforts === undefined || Array.isArray(model.supportedEfforts) && model.supportedEfforts.every((effort) => typeof effort === 'string')) &&
          (model.aliases === undefined || Array.isArray(model.aliases) && model.aliases.every((alias) => typeof alias === 'string')),
        ) && typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt) &&
          (parsed.commands === undefined || Array.isArray(parsed.commands) && parsed.commands.every((command) => typeof command === 'string'))) cached = parsed;
      } catch { /* Missing or corrupt cache is refreshed from the runtime. */ }
    }
    const now = this.options.now?.() ?? Date.now();
    const versionChanged = runtimeVersion !== undefined && runtimeVersion !== cached?.runtimeVersion;
    const versionUnavailable = this.options.version !== undefined && runtimeVersion === undefined;
    if (!force && !versionChanged && !versionUnavailable && cached?.updatedAt && now - cached.updatedAt < TTL_MS && !cached.stale) return cached;
    const pending = this.pending.get(key);
    if (pending) return pending;
    const refresh = (async (): Promise<ProviderModelCatalog> => {
      try {
        const result = await this.options.load(provider, cwd);
        const models = Array.isArray(result) ? result : result.models;
        if (models.length === 0) throw new Error('运行时没有返回可用模型，请检查 CLI 版本或配置。');
        const catalog: ProviderModelCatalog = { provider, models, updatedAt: this.options.now?.() ?? Date.now(), stale: false, runtimeVersion,
          commands: Array.isArray(result) ? undefined : result.commands };
        this.cache.set(key, catalog);
        if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value!);
        try {
          await mkdir(this.directory, { recursive: true });
          const temporary = `${filename}.${randomUUID()}.tmp`;
          await writeFile(temporary, JSON.stringify(catalog), 'utf8');
          await rename(temporary, filename);
        } catch { return { ...catalog, error: '模型已更新，但本地缓存写入失败。' }; }
        return catalog;
      } catch (error) {
        return { provider, models: cached?.models ?? [], commands: cached?.commands, updatedAt: cached?.updatedAt ?? null, stale: true, error: error instanceof Error ? error.message : String(error) };
      }
    })().finally(() => this.pending.delete(key));
    this.pending.set(key, refresh);
    return refresh;
  }
}
