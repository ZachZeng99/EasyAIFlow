import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, RpcRejectedError } from '../src/data/rpcOperations.js';

export class OperationError extends Error {
  constructor(public readonly code: string, message: string, public readonly operationId?: string) {
    super(`${code}: ${message}`);
    this.name = 'OperationError';
  }
}

export type OperationRecord = {
  id: string;
  method: string;
  fingerprint: string;
  payload?: unknown;
  /** Completion acknowledges the RPC result; its agent task may still be running. */
  status: 'started' | 'completed' | 'uncertain' | 'rejected';
  createdAt: string;
  updatedAt: string;
  result?: unknown;
  error?: string;
};

const cloneContainers = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(cloneContainers);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneContainers(item)]));
  return value;
};

export class OperationLedger {
  private readonly running = new Map<string, { fingerprint: string; promise: Promise<unknown> }>();
  constructor(
    private readonly directory: string,
    private readonly encodeResult: (result: unknown) => unknown = (result) => result,
    private readonly encodePayload: (method: string, payload: unknown) => unknown = (_method, payload) => payload,
  ) {}

  isRunning(id: string) { return this.running.has(id); }
  get pendingCount() { return this.running.size; }

  private file(id: string) {
    if (!/^[a-zA-Z0-9:_-]{1,128}$/.test(id)) {
      throw new OperationError('EAF_INVALID_OPERATION', 'Invalid operation ID.');
    }
    return path.join(this.directory, `${createHash('sha256').update(id).digest('hex')}.json`);
  }

  async get(id: string): Promise<OperationRecord | null> {
    try {
      const record = JSON.parse(await readFile(this.file(id), 'utf8')) as OperationRecord;
      if (record.id !== id || !record.fingerprint || !['started', 'completed', 'uncertain', 'rejected'].includes(record.status)) {
        throw new Error('Invalid operation record');
      }
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async save(record: OperationRecord, initial = false) {
    await mkdir(this.directory, { recursive: true });
    const destination = this.file(record.id);
    if (initial) {
      await writeFile(destination, JSON.stringify(record), { encoding: 'utf8', flag: 'wx', mode: 0o600, flush: true });
      return;
    }
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(record), { encoding: 'utf8', mode: 0o600, flush: true });
    await rename(temporary, destination);
  }

  execute(id: string, method: string, payload: unknown, operation: (capturedPayload: unknown) => Promise<unknown>): Promise<unknown> {
    const serialized = canonicalJson({ method, payload });
    const fingerprint = createHash('sha256').update(serialized).digest('hex');
    const capturedPayload = JSON.parse(serialized).payload;
    const active = this.running.get(id);
    if (active) {
      return active.fingerprint === fingerprint
        ? active.promise
        : Promise.reject(new OperationError('EAF_OPERATION_CONFLICT', 'Operation ID was reused for different input.', id));
    }
    const promise = this.executeOnce(id, method, fingerprint, capturedPayload, operation);
    this.running.set(id, { fingerprint, promise });
    void promise.finally(() => this.running.delete(id)).catch(() => undefined);
    return promise;
  }

  private async executeOnce(id: string, method: string, fingerprint: string, payload: unknown, operation: (capturedPayload: unknown) => Promise<unknown>) {
    const previous = await this.get(id);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        throw new OperationError('EAF_OPERATION_CONFLICT', 'Operation ID was reused for different input.', id);
      }
      if (previous.status === 'completed') return previous.result;
      if (previous.status === 'rejected') throw new OperationError('EAF_OPERATION_REJECTED', previous.error ?? '操作未受理。', id);
      throw new OperationError('EAF_OPERATION_UNCERTAIN', `操作 ${id} 的执行状态待确认，未重新执行。${previous.error ?? ''}`, id);
    }
    const now = new Date().toISOString();
    const record: OperationRecord = { id, method, fingerprint, payload: this.encodePayload(method, payload), status: 'started', createdAt: now, updatedAt: now };
    await this.save(record, true);
    try {
      const result = (await operation(cloneContainers(payload))) ?? null;
      await this.save({ ...record, status: 'completed', updatedAt: new Date().toISOString(), result: this.encodeResult(result) });
      return result;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (error instanceof RpcRejectedError) {
        await this.save({ ...record, status: 'rejected', updatedAt: new Date().toISOString(), error: detail });
        throw new OperationError('EAF_OPERATION_REJECTED', detail, id);
      }
      await this.save({ ...record, status: 'uncertain', updatedAt: new Date().toISOString(), error: detail }).catch(() => undefined);
      throw new OperationError('EAF_OPERATION_UNCERTAIN', `操作 ${id} 的执行状态待确认，未自动重试。${detail}`, id);
    }
  }
}
