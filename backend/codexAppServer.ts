import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

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

const CLIENT_INFO = { title: 'EasyAIFlow', name: 'EasyAIFlow', version: '0.1.0' };
const CAPABILITIES = {
  experimentalApi: false,
  optOutNotificationMethods: [
    'item/reasoning/summaryTextDelta',
    'item/reasoning/summaryPartAdded',
    'item/reasoning/textDelta',
  ],
};

const buildAppServerSpawnSpec = (platform = process.platform, comspec = process.env.ComSpec) =>
  platform === 'win32'
    ? { command: comspec?.trim() || 'cmd.exe', args: ['/d', '/s', '/c', 'codex', 'app-server'], shell: false as const }
    : { command: 'codex', args: ['app-server'], shell: false as const };

export class CodexAppServerClient {
  private child: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private notificationHandler: NotificationHandler | null = null;
  private exitError: Error | null = null;
  stderr = '';

  private constructor(child: ChildProcess) {
    this.child = child;
  }

  static async create(cwd: string): Promise<CodexAppServerClient> {
    const spec = buildAppServerSpawnSpec();
    const child = spawn(spec.command, spec.args, {
      cwd,
      shell: spec.shell,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const client = new CodexAppServerClient(child);

    child.stderr?.on('data', (chunk: Buffer | string) => {
      client.stderr += chunk.toString();
    });

    const rl = createInterface({ input: child.stdout! });
    rl.on('line', (line: string) => {
      client.handleLine(line);
    });

    child.on('close', () => {
      client.exitError = client.exitError ?? new Error('codex app-server process exited.');
      for (const [, req] of client.pending) {
        req.reject(client.exitError);
      }
      client.pending.clear();
    });

    await client.request('initialize', { clientInfo: CLIENT_INFO, capabilities: CAPABILITIES });
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
      this.notificationHandler?.({
        method: parsed.method,
        params: (parsed.params as Record<string, unknown>) ?? {},
      });
    }
  }

  private send(message: Record<string, unknown>) {
    if (!this.child.stdin?.writable) return;
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  request<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    if (this.exitError) {
      return Promise.reject(this.exitError);
    }

    const id = this.nextId++;
    this.send({ id, method, params });

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject });
    });
  }

  notify(method: string, params: Record<string, unknown> = {}) {
    this.send({ method, params });
  }

  setNotificationHandler(handler: NotificationHandler | null) {
    this.notificationHandler = handler;
  }

  async close(): Promise<void> {
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
      sandbox: params.sandbox ?? 'read-only',
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
      sandbox: params.sandbox ?? 'read-only',
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

class CodexAppServerManager {
  private instances = new Map<string, ManagedAppServer>();

  async acquire(cwd: string): Promise<CodexAppServerClient> {
    const existing = this.instances.get(cwd);
    if (existing) {
      existing.refCount++;
      return existing.client;
    }

    const client = await CodexAppServerClient.create(cwd);
    this.instances.set(cwd, { client, refCount: 1, cwd });
    return client;
  }

  release(cwd: string) {
    const managed = this.instances.get(cwd);
    if (!managed) return;

    managed.refCount--;
    if (managed.refCount <= 0) {
      this.instances.delete(cwd);
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
