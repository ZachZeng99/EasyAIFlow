import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import { mkdir, open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClaudeStreamEvent } from '../src/data/types.js';
import { MUTATING_RPC_METHODS } from '../src/data/rpcOperations.js';
import { DEVICE_SERVICE_PROTOCOL, MAX_SERVICE_MESSAGE_BYTES, readServiceKey, serviceAddress } from './deviceServiceProtocol.js';

type Options = { dataDirectory: string; homeDirectory?: string; autoStart?: boolean; executable?: string };
const transportError = (detail: string) => Object.assign(new Error(`EAF_TRANSPORT_RETRYABLE: ${detail}`), { code: 'EAF_TRANSPORT_RETRYABLE' });
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class DeviceServiceClient {
  private socket: Socket | null = null;
  private connecting: Promise<void> | null = null;
  private disposed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners = new Set<(event: ClaudeStreamEvent) => void>();
  private readonly pending = new Map<string, {
    resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>;
  }>();
  constructor(private readonly options: Options) {}

  onEvent(listener: (event: ClaudeStreamEvent) => void) {
    this.listeners.add(listener);
    if (this.socket) listener({ type: 'interaction-sync' });
    void this.connect().catch(() => this.scheduleReconnect());
    return () => { this.listeners.delete(listener); };
  }

  private emit(event: ClaudeStreamEvent) {
    for (const listener of this.listeners) {
      try { listener(event); } catch (error) { console.warn('[DEVICE_CLIENT] Event consumer failed', error); }
    }
  }

  private scheduleReconnect() {
    if (this.disposed || this.reconnectTimer || this.listeners.size === 0) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch(() => this.scheduleReconnect());
    }, 1000);
  }

  connect(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Device client is closed.'));
    if (this.socket && !this.socket.destroyed) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = this.connectOrStart().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private async connectOrStart() {
    try { await this.connectOnce(); return; } catch (error) {
      if (this.options.autoStart === false || this.disposed) throw error;
    }
    await this.startDetached();
    const deadline = Date.now() + 30000;
    let nextStart = Date.now() + 2000;
    let lastError: unknown;
    while (!this.disposed && Date.now() < deadline) {
      try { await this.connectOnce(); return; } catch (error) {
        lastError = error;
        const code = (error as NodeJS.ErrnoException).code;
        if (Date.now() >= nextStart && (code === 'ENOENT' || code === 'ECONNREFUSED')) {
          await this.startDetached();
          nextStart = Date.now() + 2000;
        }
      }
      await delay(150);
    }
    throw transportError(`Cannot connect to device service. ${lastError instanceof Error ? lastError.message : ''}`);
  }

  private async startDetached() {
    await mkdir(this.options.dataDirectory, { recursive: true });
    const isSource = import.meta.url.endsWith('.ts');
    const entry = fileURLToPath(new URL(`./deviceServiceEntry.${isSource ? 'ts' : 'js'}`, import.meta.url));
    const log = await open(path.join(this.options.dataDirectory, 'device-service.log'), 'a', 0o600);
    try {
      const runtimeFlags = process.execArgv.filter((argument) => argument.startsWith('--max-old-space-size=') || argument.startsWith('--heapsnapshot-near-heap-limit='));
      const child = spawn(this.options.executable ?? process.execPath, [...runtimeFlags, ...(isSource ? ['--import', 'tsx'] : []), entry], {
        cwd: isSource ? path.resolve(path.dirname(entry), '..') : this.options.dataDirectory,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', log.fd, log.fd],
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          EASYAIFLOW_DATA_DIR: this.options.dataDirectory,
          EASYAIFLOW_HOME_DIR: this.options.homeDirectory ?? os.homedir(),
        },
      });
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('spawn', () => { child.unref(); resolve(); });
      });
    } finally { await log.close(); }
  }

  private async connectOnce() {
    const key = await readServiceKey(this.options.dataDirectory);
    if (this.disposed) throw new Error('Device client is closed.');
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(serviceAddress(this.options.dataDirectory));
      socket.setEncoding('utf8');
      let ready = false;
      let buffer = '';
      const timeout = setTimeout(() => { reject(transportError('Service handshake timed out.')); socket.destroy(); }, 3000);
      socket.on('connect', () => socket.write(`${JSON.stringify({ type: 'auth', key, version: DEVICE_SERVICE_PROTOCOL })}\n`));
      socket.on('error', (error) => { if (!ready) reject(error); });
      socket.on('close', () => {
        clearTimeout(timeout);
        if (!ready) reject(transportError('Service connection closed before handshake.'));
        if (this.socket === socket) {
          this.socket = null;
          for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(transportError('Device connection interrupted.'));
          }
          this.pending.clear();
          this.scheduleReconnect();
        }
      });
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > MAX_SERVICE_MESSAGE_BYTES) { socket.destroy(); return; }
        let boundary: number;
        while ((boundary = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 1);
          try {
            const frame = JSON.parse(line);
            if (frame.type === 'ready' && frame.version === DEVICE_SERVICE_PROTOCOL) {
              if (this.disposed) { socket.destroy(); return; }
              ready = true;
              clearTimeout(timeout);
              this.socket = socket;
              resolve();
            } else if (frame.type === 'event' && ready) {
              this.emit(frame.event);
            } else if (frame.type === 'response' && ready) {
              const pending = this.pending.get(frame.id);
              if (!pending) continue;
              this.pending.delete(frame.id);
              clearTimeout(pending.timer);
              if (frame.error) pending.reject(Object.assign(new Error(frame.error.message), frame.error));
              else pending.resolve(frame.result);
            }
          } catch { socket.destroy(); return; }
        }
      });
    });
  }

  async request<T = unknown>(method: string, payload?: unknown, operationId?: string): Promise<T> {
    const operation = operationId ?? (MUTATING_RPC_METHODS.has(method) ? randomUUID() : undefined);
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.connect();
        return await new Promise<T>((resolve, reject) => {
          const id = randomUUID();
          const timer = setTimeout(() => {
            this.pending.delete(id);
            reject(transportError('Operation response timed out; retry with the same operation ID.'));
          }, 120000);
          this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
          const wire = `${JSON.stringify({ type: 'request', id, method, payload, operationId: operation })}\n`;
          if (Buffer.byteLength(wire) > MAX_SERVICE_MESSAGE_BYTES) {
            this.pending.delete(id); clearTimeout(timer); reject(new Error('Request exceeds the 32 MiB service limit.')); return;
          }
          if (!this.socket || this.socket.destroyed) {
            this.pending.delete(id); clearTimeout(timer); reject(transportError('Device connection interrupted.')); return;
          }
          this.socket.write(wire);
        });
      } catch (error) {
        if (attempt >= 1 || this.disposed || (error as { code?: string }).code !== 'EAF_TRANSPORT_RETRYABLE') throw error;
      }
    }
  }

  close() {
    this.disposed = true;
    clearTimeout(this.reconnectTimer);
    this.listeners.clear();
    this.socket?.destroy();
    this.socket = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Device client closed.'));
    }
    this.pending.clear();
  }
}
