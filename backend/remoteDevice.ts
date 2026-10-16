import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import type { ClaudeStreamEvent } from '../src/data/types.js';
import { DEVICE_WORK_EXCLUDED_METHODS, normalizeDeviceOrigin, type DeviceDescriptor, type DeviceIdentity, type RemoteDeviceInput, type RemoteDeviceRecord } from '../src/data/devices.js';
import { isUiRpcMethod, RpcRejectedError } from '../src/data/rpcOperations.js';
import { DeviceAccessStore } from './deviceAccessStore.js';
import { MAX_SERVICE_MESSAGE_BYTES } from './deviceServiceProtocol.js';
import { OperationError } from './operationLedger.js';

const failure = (message: string) => new OperationError('EAF_TRANSPORT_RETRYABLE', message);
const open = (origin: string, pathname: string, options: { body?: unknown; token?: string; certificate?: string; signal?: AbortSignal; timeout?: number } = {}) =>
  new Promise<IncomingMessage>((resolve, reject) => {
    const url = new URL(pathname, origin);
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    if (body && Buffer.byteLength(body) > MAX_SERVICE_MESSAGE_BYTES) { reject(new RpcRejectedError('请求超过设备传输限制。')); return; }
    const request = (url.protocol === 'https:' ? https.request : http.request)(url, {
      method: body === undefined ? 'GET' : 'POST',
      ...(url.protocol === 'https:' && options.certificate ? { ca: options.certificate } : {}),
      headers: { ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}), ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) },
      signal: options.signal,
    }, (response) => { clearTimeout(connectTimer); resolve(response); });
    const connectTimer = setTimeout(() => request.destroy(failure('设备连接超时，未确认请求结果。')), 5000);
    request.on('socket', (socket) => {
      if (!socket.connecting) clearTimeout(connectTimer);
      else socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', () => clearTimeout(connectTimer));
    });
    request.setTimeout(options.timeout ?? 120000, () => request.destroy(failure('设备响应超时，请保留原操作 ID 重试。')));
    request.on('error', (error) => { clearTimeout(connectTimer); reject(error); });
    request.end(body);
  });

const json = async <T>(origin: string, pathname: string, options: Parameters<typeof open>[2] = {}): Promise<T> => {
  const response = await open(origin, pathname, options);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_SERVICE_MESSAGE_BYTES) { response.destroy(); throw new Error('远程响应超过传输限制。'); }
    chunks.push(bytes);
  }
  let result: Record<string, unknown>;
  try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw failure('设备返回了无法读取的响应。'); }
  if (response.statusCode !== 200) throw new OperationError(typeof result.code === 'string' ? result.code : 'EAF_REMOTE_RPC_ERROR', String(result.error || `设备请求失败 (${response.statusCode})`));
  return result as T;
};

export class RemoteDeviceClient {
  private abort = new AbortController();
  private retry?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private verified = false;
  private verification?: Promise<void>;
  private retryDelay = 1000;
  readonly descriptor: DeviceDescriptor;
  constructor(readonly peer: RemoteDeviceRecord, private readonly token: string, private readonly broadcast: (event: ClaudeStreamEvent) => void) {
    this.descriptor = { id: peer.id, name: peer.name, platform: peer.platform, origin: peer.origin, kind: 'remote', connection: 'connecting' };
  }
  private connection(connection: DeviceDescriptor['connection'], error?: string) {
    if (this.disposed) return;
    this.descriptor.connection = connection;
    this.descriptor.error = error;
    if (connection === 'online') this.descriptor.lastSeen = Date.now();
    this.broadcast({ type: 'device-status', device: { ...this.descriptor }, deviceId: this.peer.id });
  }
  async request<T>(method: string, payload?: unknown, operationId?: string): Promise<T> {
    if (!isUiRpcMethod(method) || DEVICE_WORK_EXCLUDED_METHODS.has(method)) throw new RpcRejectedError('远程设备不允许此管理操作。');
    try {
      if (!this.verified) {
        this.verification ??= json<{ deviceId: string }>(this.peer.origin, '/api/rpc', {
          body: { method: 'getDeviceStatus' }, token: this.token, certificate: this.peer.certificate, timeout: 10000,
        }).then((status) => {
          if (status.deviceId !== this.peer.id) throw new OperationError('EAF_ACCESS_DENIED', '设备身份与配对记录不一致。');
          this.verified = true;
        }).finally(() => { this.verification = undefined; });
        await this.verification;
      }
      const result = await json<T>(this.peer.origin, '/api/rpc', { body: { method, payload, operationId }, token: this.token, certificate: this.peer.certificate });
      this.connection('online');
      return result;
    } catch (error) {
      if (error instanceof OperationError && !['EAF_AUTH_REQUIRED', 'EAF_ACCESS_DENIED', 'EAF_TRANSPORT_RETRYABLE'].includes(error.code)) { this.connection('online'); throw error; }
      const detail = error instanceof Error ? error.message : String(error);
      this.connection('offline', detail);
      if (error instanceof OperationError || error instanceof RpcRejectedError) throw error;
      throw failure('执行设备连接中断；请重连后用原操作 ID 核对结果。');
    }
  }
  start() { void this.stream(); }
  private async stream() {
    try {
      const status = await this.request<{ deviceId: string; active: boolean }>('getDeviceStatus');
      if (status.deviceId !== this.peer.id) throw new Error('设备身份与配对记录不一致。');
      this.descriptor.active = status.active;
      const response = await open(this.peer.origin, '/api/events', { token: this.token, certificate: this.peer.certificate, signal: this.abort.signal, timeout: 45000 });
      if (response.statusCode !== 200 || !response.headers['content-type']?.startsWith('text/event-stream')) { response.destroy(); throw new Error(`设备事件连接被拒绝 (${response.statusCode})。`); }
      this.connection('online');
      this.retryDelay = 1000;
      this.broadcast({ type: 'interaction-sync', deviceId: this.peer.id });
      let buffer = '';
      response.setEncoding('utf8');
      for await (const chunk of response) {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > MAX_SERVICE_MESSAGE_BYTES) throw new Error('设备事件超过传输限制。');
        let index: number;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).trimEnd(); buffer = buffer.slice(index + 1);
          if (!line.startsWith('data:')) continue;
          const event = JSON.parse(line.slice(5).trim()) as ClaudeStreamEvent;
          if (event.deviceId) continue; // A peer cannot forward another machine's events transitively.
          this.broadcast({ ...event, deviceId: this.peer.id });
        }
      }
      throw new Error('设备事件连接已断开。');
    } catch (error) {
      if (this.disposed) return;
      this.verified = false;
      this.connection('offline', error instanceof Error ? error.message : '设备离线。');
      this.retry = setTimeout(() => void this.stream(), this.retryDelay);
      this.retryDelay = Math.min(15000, this.retryDelay * 2);
    }
  }
  close() { this.disposed = true; clearTimeout(this.retry); this.abort.abort(); }
}

export class RemoteDeviceRouter {
  private readonly clients = new Map<string, RemoteDeviceClient>();
  constructor(private readonly access: DeviceAccessStore, private readonly broadcast: (event: ClaudeStreamEvent) => void) {
    for (const peer of access.peers) this.connect(peer);
  }
  private connect(peer: RemoteDeviceRecord) {
    this.clients.get(peer.id)?.close();
    const client = new RemoteDeviceClient(peer, this.access.tokenFor(peer), this.broadcast);
    this.clients.set(peer.id, client);
    client.start();
  }
  list(): DeviceDescriptor[] { return [...this.clients.values()].map((client) => ({ ...client.descriptor })); }
  request<T>(id: string, method: string, payload?: unknown, operationId?: string) {
    const client = this.clients.get(id);
    if (!client) return Promise.reject(new OperationError('EAF_DEVICE_UNAVAILABLE', '设备未配对或已移除。'));
    return client.request<T>(method, payload, operationId);
  }
  async add(input: RemoteDeviceInput): Promise<DeviceDescriptor> {
    if (!input || typeof input.origin !== 'string' || typeof input.code !== 'string' || input.code.length > 256 || !input.code.trim()) throw new RpcRejectedError('请填写设备地址和控制配对码。');
    let origin: string;
    try { origin = normalizeDeviceOrigin(input.origin, input.trustedVpn === true); }
    catch (error) { throw new RpcRejectedError(error instanceof Error ? error.message : '设备地址无效。'); }
    if (input.certificate && (input.certificate.length > 65536 || !input.certificate.includes('-----BEGIN CERTIFICATE-----') || input.certificate.includes('PRIVATE KEY'))) throw new RpcRejectedError('仅可填写公开的 PEM 证书。');
    let info: { kind: string; device: DeviceIdentity };
    try { info = await json(origin, '/api/device/info', { certificate: input.certificate, timeout: 10000 }); }
    catch { throw new RpcRejectedError('无法验证设备地址，请检查网关、网络和证书。'); }
    if (info.kind !== 'eaf-device' || !/^[a-f0-9-]{36}$/i.test(info.device?.id ?? '') || typeof info.device?.name !== 'string') throw new RpcRejectedError('这个地址没有返回有效的 EAF 设备身份。');
    if (input.expectedDeviceId && input.expectedDeviceId !== info.device.id) throw new RpcRejectedError('设备身份与配对信息不一致。');
    if (info.device.id === this.access.identity.id) throw new RpcRejectedError('这个地址属于本机，无需重复添加。');
    const paired = await json<{ device: DeviceIdentity; token: string }>(origin, '/api/device/pair', { certificate: input.certificate,
      body: { code: input.code, purpose: 'device', name: this.access.identity.name }, timeout: 10000 }).catch((error: unknown) => {
        if (error instanceof OperationError && error.code === 'EAF_AUTH_REQUIRED') throw new RpcRejectedError('控制配对码无效、已使用或已过期，请重新生成。');
        throw error;
      });
    if (paired.device.id !== info.device.id || !/^[A-Za-z0-9_-]{43}$/.test(paired.token)) throw new Error('设备配对响应无效。');
    try {
      await this.access.savePeer({ ...info.device, name: input.name?.trim().slice(0, 80) || info.device.name, origin,
        certificate: input.certificate, trustedVpn: input.trustedVpn, pairedAt: Date.now() }, paired.token);
    } catch (error) {
      // Compensate an issued grant if the local pairing cannot be saved.
      await json(origin, '/api/device/logout', { body: {}, token: paired.token, certificate: input.certificate, timeout: 10000 }).catch(() => undefined);
      throw error;
    }
    const peer = this.access.peers.find((entry) => entry.id === info.device.id)!;
    this.connect(peer);
    return { ...this.clients.get(peer.id)!.descriptor };
  }
  async remove(id: string) {
    await this.access.removePeer(id);
    this.clients.get(id)?.close();
    this.clients.delete(id);
  }
  close() { for (const client of this.clients.values()) client.close(); this.clients.clear(); }
}
