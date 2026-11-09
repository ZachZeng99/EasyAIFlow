import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, createConnection, type Socket } from 'node:net';
import { chmod, unlink } from 'node:fs/promises';
import path from 'node:path';
import { configureRuntimePaths } from './runtimePaths.js';
import { createDeviceRuntime } from './deviceRuntime.js';
import { OperationLedger, OperationError } from './operationLedger.js';
import { MUTATING_RPC_METHODS, stripRpcMetadata, isUiRpcMethod } from '../src/data/rpcOperations.js';
import type { ClaudeStreamEvent } from '../src/data/types.js';
import { DEVICE_SERVICE_PROTOCOL, MAX_SERVICE_MESSAGE_BYTES, ensureServiceKey, serviceAddress } from './deviceServiceProtocol.js';
import { DeviceAccessStore } from './deviceAccessStore.js';
import { RemoteDeviceRouter } from './remoteDevice.js';
import { createRemoteEventHub, type RemoteExecutionPort } from './remoteExecution.js';
import { DEVICE_WORK_EXCLUDED_METHODS, type DeviceAccessPurpose, type RemoteDeviceInput } from '../src/data/devices.js';

export const startDeviceService = async (options: { dataDirectory: string; homeDirectory: string }) => {
  configureRuntimePaths({ mode: 'web', userDataPath: options.dataDirectory, homePath: options.homeDirectory });
  const key = await ensureServiceKey(options.dataDirectory);
  const address = serviceAddress(options.dataDirectory);
  const instanceId = randomUUID();
  const access = await DeviceAccessStore.open(options.dataDirectory, key);
  const clients = new Set<Socket>();
  const ledger = new OperationLedger(path.join(options.dataDirectory, 'operations'), (result) => {
    if (!result || typeof result !== 'object') return result;
    const compact = { ...result } as Record<string, unknown>;
    // Store stable identities, not a copy of every project on every command.
    if (Array.isArray(compact.projects)) compact.projects = [];
    for (const key of ['project', 'streamwork', 'session']) {
      const entity = compact[key] as { id?: string } | undefined;
      if (entity?.id) compact[key] = { id: entity.id };
    }
    return compact;
  }, (method, payload) => method === 'addRemoteDevice' && payload && typeof payload === 'object'
    ? { ...payload, code: '[redacted]' } : payload);
  const send = (socket: Socket, value: unknown) => {
    if (socket.destroyed) return;
    if (socket.writableLength > 8 * 1024 * 1024) { socket.destroy(); return; }
    socket.write(`${JSON.stringify(value)}\n`);
  };
  const broadcast = (event: ClaudeStreamEvent) => {
    for (const client of clients) send(client, { type: 'event', event });
  };
  const remoteEvents = createRemoteEventHub();
  let router: RemoteDeviceRouter | undefined;
  const remotePort: RemoteExecutionPort = {
    request: (deviceId, method, payload, operationId) => router
      ? router.request(deviceId, method, payload, operationId)
      : Promise.reject(new OperationError('EAF_DEVICE_UNAVAILABLE', '设备连接尚未初始化。')),
    subscribe: remoteEvents.subscribe,
    describe: (deviceId) => router?.list().find((device) => device.id === deviceId),
  };
  const runtime = createDeviceRuntime(broadcast, instanceId, remotePort);
  const peers = new RemoteDeviceRouter(access, (event) => { broadcast(event); remoteEvents.publish(event); });
  router = peers;
  let stopping = false;
  let activeRequests = 0;
  let stopPromise: Promise<void> | null = null;
  const server = createServer((socket) => {
    socket.setEncoding('utf8');
    let authenticated = false;
    let buffer = '';
    const timeout = setTimeout(() => socket.destroy(), 5000);
    socket.on('error', () => socket.destroy());
    socket.on('close', () => { clearTimeout(timeout); clients.delete(socket); });
    const handle = async (frame: Record<string, unknown>) => {
      if (stopping && !authenticated) { socket.destroy(); return; }
      if (!authenticated) {
        const supplied = typeof frame.key === 'string' ? frame.key : '';
        if (frame.type !== 'auth' || frame.version !== DEVICE_SERVICE_PROTOCOL || supplied.length !== key.length ||
          !timingSafeEqual(Buffer.from(supplied), Buffer.from(key))) {
          socket.destroy();
          return;
        }
        authenticated = true;
        clearTimeout(timeout);
        clients.add(socket);
        send(socket, { type: 'ready', version: DEVICE_SERVICE_PROTOCOL, instanceId });
        send(socket, { type: 'event', event: { type: 'interaction-sync' } });
        send(socket, { type: 'event', event: { type: 'interaction-snapshot', snapshot: runtime.interactionSnapshot(), connection: true } });
        return;
      }
      if (frame.type !== 'request' || typeof frame.id !== 'string' || typeof frame.method !== 'string') return;
      activeRequests += 1;
      try {
        if (stopping) throw new Error('Device service is stopping.');
        const method = frame.method;
        const targetDevice = typeof frame.deviceId === 'string' ? frame.deviceId : 'local';
        if (frame.remoteAccessToken !== undefined) {
          const grant = typeof frame.remoteAccessToken === 'string' ? access.authorize(frame.remoteAccessToken) : undefined;
          if (!grant) throw new OperationError('EAF_AUTH_REQUIRED', '设备授权已失效，请重新配对。');
          if (!isUiRpcMethod(method) || grant.purpose === 'device' &&
            (DEVICE_WORK_EXCLUDED_METHODS.has(method) || targetDevice !== 'local' && targetDevice !== access.identity.id)) {
            throw new OperationError('EAF_ACCESS_DENIED', '此设备授权不允许转发到其他机器或修改接入配置。');
          }
          // A device grant controls this machine only; it must not drive this
          // machine's own peers indirectly through cross-device group members.
          if (grant.purpose === 'device' && await runtime.involvesRemoteMembers(method, frame.payload)) {
            throw new OperationError('EAF_ACCESS_DENIED', '该群聊包含其他设备上的成员；设备授权不能间接操作其他设备，请在协调设备本机或其浏览器登录中操作。');
          }
        }
        let result: unknown;
        if (targetDevice !== 'local' && targetDevice !== access.identity.id) {
          result = await peers.request(targetDevice, method, frame.payload, typeof frame.operationId === 'string' ? frame.operationId : undefined);
        } else if (method === 'getDeviceStatus') {
          result = { instanceId, deviceId: access.identity.id, name: access.identity.name, platform: access.identity.platform, pid: process.pid, active: runtime.hasActiveWork(), protocol: DEVICE_SERVICE_PROTOCOL };
        } else if (method === 'getLocalDeviceIdentity') {
          result = access.identity;
        } else if (method === 'getGroupPlacementOptions') {
          result = { devices: await Promise.all(peers.list().map(async (device) => {
            if (device.connection !== 'online') return { id: device.id, name: device.name, connection: device.connection, projects: [] };
            try {
              const { projects } = await peers.request<{ projects: Array<{ id: string; name: string; rootPath: string; dreams: unknown[] }> }>(device.id, 'getProjects');
              return { id: device.id, name: device.name, connection: device.connection,
                projects: projects.filter((project) => project.dreams.length > 0).map(({ id, name, rootPath }) => ({ id, name, rootPath })) };
            } catch (error) {
              return { id: device.id, name: device.name, connection: 'offline' as const, projects: [], error: error instanceof Error ? error.message : '设备读取失败。' };
            }
          })) };
        } else if (method === 'getDevices') {
          result = { devices: [{ ...access.identity, kind: 'local', connection: 'online', active: runtime.hasActiveWork() }, ...peers.list()] };
        } else if (method === 'createDevicePairing') {
          result = access.createPairing((frame.payload as { purpose: DeviceAccessPurpose })?.purpose, typeof frame.operationId === 'string' ? frame.operationId : undefined);
        } else if (method === 'exchangeDevicePairing') {
          const payload = frame.payload as { code: string; purpose: DeviceAccessPurpose; name: string };
          result = await access.exchange(payload.code, payload.purpose, payload.name);
        } else if (method === 'authorizeDeviceAccess') {
          result = access.authorize((frame.payload as { token: string }).token) ?? null;
        } else if (method === 'getDeviceAccessGrants') {
          result = { grants: access.grants };
        } else if (['addRemoteDevice', 'removeRemoteDevice', 'revokeDeviceAccess'].includes(method)) {
          if (typeof frame.operationId !== 'string') throw new OperationError('EAF_INVALID_OPERATION', 'Operation ID is required.');
          const saved = await ledger.execute(frame.operationId, method, stripRpcMetadata(method, frame.payload), async (input) => {
            if (method === 'addRemoteDevice') return peers.add(input as RemoteDeviceInput);
            if (method === 'removeRemoteDevice') { await peers.remove((input as { deviceId: string }).deviceId); return null; }
            const grantId = (input as { grantId: string }).grantId;
            await access.revoke(grantId);
            broadcast({ type: 'device-access-revoked', grantId });
            return null;
          });
          result = method === 'addRemoteDevice' ? peers.list().find((peer) => peer.id === (saved as { id: string })?.id) ?? null
            : method === 'revokeDeviceAccess' ? { grants: access.grants } : { devices: peers.list() };
        } else if (method === 'getInteractionEvents') {
          result = runtime.interactionEvents();
        } else if (method === 'getInteractionSnapshot') {
          result = runtime.interactionSnapshot();
        } else if (method === 'getOperationStatus') {
          const id = (frame.payload as { operationId?: string } | undefined)?.operationId;
          if (!id) throw new Error('Operation ID is required.');
          const record = await ledger.get(id);
          result = record ? { ...record, status: record.status === 'started' && !ledger.isRunning(id) ? 'uncertain' : record.status } : null;
        } else if (method === 'shutdownDeviceService') {
          if (runtime.hasActiveWork() || ledger.pendingCount > 0 || activeRequests > 1) throw new Error('Device service still has active tasks or operations.');
          stopping = true;
          send(socket, { type: 'response', id: frame.id, result: null });
          setImmediate(() => void stop().catch((error) => console.error('[DEVICE_SERVICE] Shutdown failed', error)));
          return;
        } else {
          if (!Object.hasOwn(runtime.handlers, method)) throw new Error('Unknown RPC method.');
          const handler = runtime.handlers[method as keyof typeof runtime.handlers];
          const payload = stripRpcMetadata(method, frame.payload);
          if (MUTATING_RPC_METHODS.has(method)) {
            if (typeof frame.operationId !== 'string') throw new OperationError('EAF_INVALID_OPERATION', 'Operation ID is required.');
            const previous = await ledger.get(frame.operationId);
            result = await ledger.execute(frame.operationId, method, payload, (capturedPayload) => handler(capturedPayload as never));
            if (previous?.status === 'completed' && result && typeof result === 'object' && 'projects' in result) {
              const fresh = { ...result } as Record<string, unknown>;
              const { projects } = await runtime.handlers.getProjects();
              fresh.projects = projects;
              const missing = () => new OperationError('EAF_OPERATION_ALREADY_APPLIED', '此前操作已完成，但对应对象已被移除；未重复执行。', frame.operationId as string);
              if (fresh.project) {
                fresh.project = projects.find((project) => project.id === (fresh.project as { id: string }).id);
                if (!fresh.project) throw missing();
              }
              if (fresh.streamwork) {
                fresh.streamwork = projects.flatMap((project) => project.dreams).find((dream) => dream.id === (fresh.streamwork as { id: string }).id);
                if (!fresh.streamwork) throw missing();
              }
              if (fresh.session) {
                try { fresh.session = await runtime.handlers.getSessionRecord({ sessionId: (fresh.session as { id: string }).id }); }
                catch { throw missing(); }
              }
              result = fresh;
            }
          } else {
            result = await handler(payload as never);
          }
        }
        send(socket, { type: 'response', id: frame.id, result: result ?? null });
      } catch (error) {
        send(socket, { type: 'response', id: frame.id, error: {
          message: error instanceof Error ? error.message : String(error),
          code: error instanceof OperationError ? error.code : 'EAF_RPC_ERROR',
          operationId: error instanceof OperationError ? error.operationId : undefined,
        } });
      } finally { activeRequests -= 1; }
    };
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_SERVICE_MESSAGE_BYTES) { socket.destroy(); return; }
      let boundary: number;
      while ((boundary = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 1);
        try {
          const frame = JSON.parse(line);
          if (!frame || typeof frame !== 'object' || Array.isArray(frame)) { socket.destroy(); return; }
          void handle(frame).catch(() => socket.destroy());
        } catch { socket.destroy(); return; }
      }
    });
  });
  const stop = () => {
    if (stopPromise) return stopPromise;
    stopping = true;
    stopPromise = (async () => {
      peers.close();
      try { await runtime.close(); }
      finally {
        for (const socket of clients) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    })();
    return stopPromise;
  };
  // Unix sockets can remain after a crash; only remove a socket that refuses a
  // connection. Windows named pipes are removed by the operating system.
  if (process.platform !== 'win32') {
    await new Promise<void>((resolve, reject) => {
      const probe = createConnection(address);
      probe.once('connect', () => { probe.destroy(); reject(Object.assign(new Error('Service already running'), { code: 'EADDRINUSE' })); });
      probe.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ECONNREFUSED') void unlink(address).then(resolve, reject);
        else if (error.code === 'ENOENT') resolve();
        else reject(error);
      });
    });
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(address, () => { server.removeListener('error', reject); resolve(); });
  });
  if (process.platform !== 'win32') await chmod(address, 0o600);
  return { stop, instanceId, address };
};
