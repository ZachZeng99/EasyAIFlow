import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { captureProviderFrame } from './protocolCapture.js';
import { codexRuntimeResolver, codexRuntimeSpawnSpec, type CodexRuntime } from './codexRuntime.js';

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type JsonRpcNotification = {
  method: string;
  params: Record<string, unknown>;
};

type NotificationHandler = (notification: JsonRpcNotification) => void;
type ExitHandler = (error: Error) => void;

const CLIENT_INFO = { title: 'EasyAIFlow', name: 'EasyAIFlow', version: '2.0.0-alpha.1' };
const CAPABILITIES = {
  experimentalApi: false,
  optOutNotificationMethods: [
    'item/reasoning/summaryTextDelta',
    'item/reasoning/summaryPartAdded',
    'item/reasoning/textDelta',
  ],
};

export class CodexAppServerClient {
  private readonly captureId = randomUUID();
  private child: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private notificationHandlers = new Set<NotificationHandler>();
  private exitHandlers = new Set<ExitHandler>();
  private exitError: Error | null = null;
  stderr = '';

  private constructor(child: ChildProcess, readonly runtime: CodexRuntime) {
    this.child = child;
  }

  static async create(cwd: string, options?: { timeoutMs?: number; runtime?: CodexRuntime }): Promise<CodexAppServerClient> {
    const runtime = options?.runtime ?? await codexRuntimeResolver.resolve();
    const spec = codexRuntimeSpawnSpec(runtime, ['app-server']);
    const child = spawn(spec.command, spec.args, {
      cwd,
      shell: spec.shell,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const client = new CodexAppServerClient(child, runtime);

    child.stderr?.on('data', (chunk: Buffer | string) => {
      client.stderr += chunk.toString();
    });

    const rl = createInterface({ input: child.stdout! });
    rl.on('line', (line: string) => {
      client.handleLine(line);
    });

    const fail = (error: Error) => {
      if (client.exitError) return;
      client.exitError = error;
      for (const handler of client.exitHandlers) {
        handler(client.exitError);
      }
      for (const [, req] of client.pending) {
        req.reject(client.exitError);
      }
      client.pending.clear();
    };
    child.on('error', fail);
    child.stdin?.on('error', fail);
    child.on('close', () => fail(new Error('codex app-server process exited.')));

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const initialized = client.request('initialize', { clientInfo: CLIENT_INFO, capabilities: CAPABILITIES });
      if (options?.timeoutMs) {
        await Promise.race([initialized, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Codex initialization timed out.')), options.timeoutMs);
        })]);
      } else await initialized;
    } catch (error) {
      await client.close();
      throw error;
    } finally { clearTimeout(timer); }
    client.notify('initialized', {});
    return client;
  }

  private handleLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }
    captureProviderFrame('codex', this.captureId, parsed);

    // Response to a request we sent.
    if (typeof parsed.id === 'number' && (parsed.result !== undefined || parsed.error !== undefined)) {
      const pending = this.pending.get(parsed.id);
      if (!pending) return;
      this.pending.delete(parsed.id);

      if (parsed.error && typeof parsed.error === 'object') {
        const err = parsed.error as { code?: number; message?: string };
        const error = new Error(err.message ?? 'JSON-RPC error');
        (error as Error & { rpcCode?: number }).rpcCode = err.code;
        pending.reject(error);
      } else {
        pending.resolve(parsed.result);
      }
      return;
    }

    // Server-initiated request (we reject unsupported server requests).
    if (typeof parsed.id === 'number' && typeof parsed.method === 'string') {
      this.send({
        id: parsed.id,
        error: { code: -32601, message: `Unsupported server request: ${parsed.method}` },
      });
      return;
    }

    // Notification from server.
    if (typeof parsed.method === 'string') {
      const notification: JsonRpcNotification = {
        method: parsed.method,
        params: (parsed.params as Record<string, unknown>) ?? {},
      };
      for (const handler of this.notificationHandlers) {
        handler(notification);
      }
    }
  }

  private send(message: Record<string, unknown>): boolean {
    if (!this.child.stdin?.writable) return false;
    this.child.stdin.write(JSON.stringify(message) + '\n');
    return true;
  }

  request<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    if (this.exitError) {
      return Promise.reject(this.exitError);
    }

    const id = this.nextId++;
    if (!this.send({ id, method, params })) {
      return Promise.reject(new Error('Codex app-server stdin is not writable.'));
    }

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject });
    });
  }

  notify(method: string, params: Record<string, unknown> = {}) {
    this.send({ method, params });
  }

  addNotificationHandler(handler: NotificationHandler) {
    this.notificationHandlers.add(handler);
  }

  removeNotificationHandler(handler: NotificationHandler) {
    this.notificationHandlers.delete(handler);
  }

  addExitHandler(handler: ExitHandler) {
    this.exitHandlers.add(handler);
  }

  removeExitHandler(handler: ExitHandler) {
    this.exitHandlers.delete(handler);
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    if (this.child.stdin?.writable) {
      this.child.stdin.end();
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.child.killed) {
          this.child.kill();
        }
        resolve();
      }, 500);
      this.child.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async threadStart(params: {
    cwd: string;
    model: string | null;
    approvalPolicy?: string;
    sandbox?: string;
    serviceName?: string;
    ephemeral?: boolean;
  }) {
    return this.request<{ thread: { id: string; name?: string } }>('thread/start', {
      cwd: params.cwd,
      model: params.model,
      approvalPolicy: params.approvalPolicy ?? 'never',
      sandbox: params.sandbox ?? 'danger-full-access',
      serviceName: params.serviceName ?? 'easyaiflow_group_chat',
      ephemeral: params.ephemeral ?? false,
      experimentalRawEvents: false,
    });
  }

  async threadResume(params: {
    threadId: string;
    cwd: string;
    model: string | null;
    sandbox?: string;
  }) {
    return this.request<{ thread: { id: string } }>('thread/resume', {
      threadId: params.threadId,
      cwd: params.cwd,
      model: params.model,
      approvalPolicy: 'never',
      sandbox: params.sandbox ?? 'danger-full-access',
    });
  }

  async turnStart(params: {
    threadId: string;
    prompt: string;
    model?: string | null;
    effort?: string | null;
    outputSchema?: object | null;
  }) {
    return this.request<{ turn: { id: string; status: string } }>('turn/start', {
      threadId: params.threadId,
      input: [{ type: 'text', text: params.prompt, text_elements: [] }],
      model: params.model ?? null,
      effort: params.effort ?? null,
      outputSchema: params.outputSchema ?? null,
    });
  }

  async turnInterrupt(params: { threadId: string; turnId: string }) {
    return this.request('turn/interrupt', params);
  }

  async threadSetName(threadId: string, name: string) {
    return this.request('thread/name/set', { threadId, name });
  }
}

type ManagedAppServer = {
  client: CodexAppServerClient;
  refCount: number;
  cwd: string;
};

export class CodexAppServerManager {
  private instances = new Map<string, ManagedAppServer>();
  private pendingCreates = new Map<string, Promise<ManagedAppServer>>();
  constructor(
    private readonly resolveRuntime = () => codexRuntimeResolver.resolve(),
    private readonly createClient = (cwd: string, runtime: CodexRuntime) => CodexAppServerClient.create(cwd, { runtime }),
  ) {}

  async acquire(cwd: string): Promise<CodexAppServerClient> {
    const runtime = await this.resolveRuntime();
    const key = JSON.stringify([cwd, runtime.identity]);
    const existing = this.instances.get(key);
    if (existing) {
      existing.refCount++;
      return existing.client;
    }

    const pendingCreate = this.pendingCreates.get(key);
    if (pendingCreate) {
      const managed = await pendingCreate;
      managed.refCount++;
      return managed.client;
    }

    const createPromise = this.createClient(cwd, runtime)
      .then((client) => {
        const managed = { client, refCount: 0, cwd };
        this.instances.set(key, managed);
        return managed;
      })
      .finally(() => {
        this.pendingCreates.delete(key);
      });

    this.pendingCreates.set(key, createPromise);
    const managed = await createPromise;
    managed.refCount++;
    return managed.client;
  }

  release(cwd: string, client?: CodexAppServerClient) {
    const matches = [...this.instances].filter(([, managed]) => managed.cwd === cwd && (!client || managed.client === client));
    if (!matches.length) return;
    if (matches.length > 1) throw new Error('A client identity is required to release a replaced Codex runtime.');
    const [key, managed] = matches[0];

    managed.refCount--;
    if (managed.refCount <= 0) {
      this.instances.delete(key);
      void managed.client.close();
    }
  }

  async closeAll() {
    const entries = [...this.instances.values()];
    this.instances.clear();
    await Promise.allSettled(entries.map((entry) => entry.client.close()));
  }
}

export const appServerManager = new CodexAppServerManager();
