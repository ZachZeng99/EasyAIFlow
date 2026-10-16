import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { DeviceServiceClient } from '../backend/deviceServiceClient.js';
import { resolveDefaultWebUserDataPath } from '../backend/runtimePaths.js';
import { createSseClientRegistry } from './sseClients.js';
import type { ClaudeStreamEvent } from '../src/data/types.js';
import { isUiRpcMethod } from '../src/data/rpcOperations.js';
import { DEVICE_WORK_EXCLUDED_METHODS, type DeviceAccessGrant, type DeviceIdentity } from '../src/data/devices.js';

const device = new DeviceServiceClient({
  dataDirectory: resolveDefaultWebUserDataPath({ pathExists: existsSync, env: process.env }),
  homeDirectory: process.env.EASYAIFLOW_HOME_DIR || process.env.USERPROFILE || os.homedir(),
});
const eventClients = createSseClientRegistry();
const subscriptions = new Map<ServerResponse, { deviceId: string; grantId?: string; purpose?: string }>();
const revokedGrants = new Set<string>();
device.onEvent((event) => {
  if (event.type === 'interaction-sync' && !event.deviceId) {
    // Reauthorize subscriptions after a daemon reconnect: grants may have been
    // revoked while this gateway was disconnected from the service.
    for (const response of subscriptions.keys()) { eventClients.remove(response); response.end(); }
    subscriptions.clear();
    return;
  }
  if (event.type === 'device-access-revoked') {
    revokedGrants.add(event.grantId);
    if (revokedGrants.size > 1024) revokedGrants.delete(revokedGrants.values().next().value!);
    for (const [response, subscription] of subscriptions) if (subscription.grantId === event.grantId) response.end();
    return;
  }
  for (const [response, subscription] of subscriptions) {
    if ((event.deviceId ?? 'local') === subscription.deviceId) eventClients.writeEvent(response, event);
  }
});
await device.connect();
const localIdentity = await device.request<DeviceIdentity>('getLocalDeviceIdentity');
const certificate = process.env.EASYAIFLOW_TLS_CERT ? await readFile(process.env.EASYAIFLOW_TLS_CERT, 'utf8') : undefined;
const privateKey = process.env.EASYAIFLOW_TLS_KEY ? await readFile(process.env.EASYAIFLOW_TLS_KEY, 'utf8') : undefined;
if (Boolean(certificate) !== Boolean(privateKey)) throw new Error('HTTPS requires both EASYAIFLOW_TLS_CERT and EASYAIFLOW_TLS_KEY.');
const isLoopback = (address: string) => address === '::1' || address === '127.0.0.1' || address === '::ffff:127.0.0.1';
const isLoopbackHost = (host: string) => ['localhost', '127.0.0.1', '[::1]'].includes(host);
const pairingAttempts = new Map<string, { started: number; count: number }>();

const parseJsonBody = async (request: IncomingMessage, maximumBytes = 32 * 1024 * 1024) => {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > maximumBytes) throw new Error('Request body exceeds the allowed size.');
    chunks.push(bytes);
  }

  if (chunks.length === 0) {
    return undefined;
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
    method?: string;
    operationId?: string;
    payload?: unknown;
    deviceId?: string;
  };
};

const canUseGzip = (request: IncomingMessage) =>
  typeof request.headers['accept-encoding'] === 'string' &&
  request.headers['accept-encoding'].includes('gzip');

const isCompressibleContentType = (contentType: string) =>
  /^(text\/|application\/(?:json|javascript)|image\/svg\+xml)/i.test(contentType);

const mergeVaryHeader = (existing: string | number | string[] | undefined, value: string) => {
  const values = new Set(
    String(existing ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
  values.add(value);
  return [...values].join(', ');
};

const sendBody = (
  request: IncomingMessage,
  response: ServerResponse<IncomingMessage>,
  statusCode: number,
  headers: Record<string, string>,
  body: Buffer | string,
) => {
  const normalizedBody = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  const contentType = headers['Content-Type'] ?? 'application/octet-stream';
  const shouldCompress =
    normalizedBody.length >= 1024 &&
    canUseGzip(request) &&
    isCompressibleContentType(contentType);

  if (shouldCompress) {
    const compressed = gzipSync(normalizedBody);
    response.writeHead(statusCode, {
      ...headers,
      'Content-Encoding': 'gzip',
      'Content-Length': String(compressed.length),
      Vary: mergeVaryHeader(headers.Vary, 'Accept-Encoding'),
    });
    response.end(compressed);
    return;
  }

  response.writeHead(statusCode, {
    ...headers,
    'Content-Length': String(normalizedBody.length),
  });
  response.end(normalizedBody);
};

const respondJson = (
  request: IncomingMessage,
  response: ServerResponse<IncomingMessage>,
  statusCode: number,
  payload: unknown,
) => {
  sendBody(request, response, statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  }, JSON.stringify(payload));
};

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const staticRoot = path.resolve(process.cwd(), 'dist');

const serveStatic = async (
  request: IncomingMessage,
  requestPath: string,
  response: ServerResponse<IncomingMessage>,
) => {
  const sanitizedPath = requestPath === '/' ? '/index.html' : requestPath;
  const targetPath = path.resolve(staticRoot, `.${sanitizedPath}`);
  const isInsideDist = targetPath.startsWith(`${staticRoot}${path.sep}`);

  if (isInsideDist) {
    try {
      const info = await stat(targetPath);
      if (info.isFile()) {
        const body = await readFile(targetPath);
        sendBody(request, response, 200, {
          'Content-Type': MIME_TYPES[path.extname(targetPath)] ?? 'application/octet-stream',
          'Cache-Control': 'no-cache',
        }, body);
        return true;
      }
    } catch {
      // Fall through to SPA index handling.
    }
  }

  try {
    const indexHtml = await readFile(path.join(staticRoot, 'index.html'));
    sendBody(request, response, 200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
    }, indexHtml);
    return true;
  } catch {
    sendBody(request, response, 200, {
      'Content-Type': 'text/plain; charset=utf-8',
    }, 'EasyAIFlow web API is running. Build the client with "npm run build:web" to serve the UI here.');
    return true;
  }
};


const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? process.env.EASYAIFLOW_WEB_SERVER_PORT ?? 8887);
const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? `localhost:${port}`}`);
  if (request.headers.origin) {
    let allowed = false;
    try {
      const expectedOrigin = process.env.EASYAIFLOW_PUBLIC_ORIGIN || `${(request.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http'}://${request.headers.host}`;
      allowed = new URL(request.headers.origin).origin === new URL(expectedOrigin).origin;
    } catch { /* Invalid origin. */ }
    if (!allowed) { respondJson(request, response, 403, { error: 'Cross-origin access is not allowed.' }); return; }
  }
  if (request.method === 'OPTIONS') {
    response.writeHead(204, { 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' });
    response.end();
    return;
  }
  const loopbackPeer = isLoopback(request.socket.remoteAddress ?? '');
  const secure = Boolean((request.socket as { encrypted?: boolean }).encrypted) ||
    loopbackPeer && process.env.EASYAIFLOW_PUBLIC_ORIGIN?.startsWith('https://');
  if (url.pathname.startsWith('/api/') && !loopbackPeer && !secure && process.env.EASYAIFLOW_TRUSTED_VPN !== '1') {
    respondJson(request, response, 403, { code: 'EAF_TLS_REQUIRED', error: '远程访问需要 HTTPS 或明确配置的加密 VPN。' }); return;
  }
  if (request.method === 'GET' && url.pathname === '/api/device/info') {
    respondJson(request, response, 200, { kind: 'eaf-device', protocol: 1, device: localIdentity, certificate }); return;
  }
  if (request.method === 'POST' && url.pathname === '/api/device/pair') {
    const address = request.socket.remoteAddress ?? 'unknown';
    const attempt = pairingAttempts.get(address);
    const window = attempt && Date.now() - attempt.started < 60000 ? attempt : { started: Date.now(), count: 0 };
    if (++window.count > 20) { respondJson(request, response, 429, { error: '配对尝试过多，请稍后再试。' }); return; }
    pairingAttempts.set(address, window);
    if (pairingAttempts.size > 1024) pairingAttempts.delete(pairingAttempts.keys().next().value!);
    try {
      const input = await parseJsonBody(request, 4096) as { code?: unknown; purpose?: unknown; name?: unknown };
      if (typeof input?.code !== 'string' || !['device', 'browser'].includes(String(input.purpose))) throw new Error('配对请求无效。');
      const paired = await device.request<{ token: string; device: DeviceIdentity; grantId: string }>('exchangeDevicePairing', {
        code: input.code.trim(), purpose: input.purpose, name: typeof input.name === 'string' ? input.name : '浏览器',
      });
      if (input.purpose === 'browser') {
        response.setHeader('Set-Cookie', `eaf_device_access=${paired.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${secure ? '; Secure' : ''}`);
        respondJson(request, response, 200, { device: paired.device });
      } else respondJson(request, response, 200, paired);
    } catch { respondJson(request, response, 401, { code: 'EAF_AUTH_REQUIRED', error: '配对码无效、已使用、用途不匹配或已过期。' }); }
    return;
  }
  const bearer = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1];
  const cookie = request.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith('eaf_device_access='))?.slice('eaf_device_access='.length);
  const token = bearer || cookie;
  const localOwner = loopbackPeer && isLoopbackHost(url.hostname) && !process.env.EASYAIFLOW_PUBLIC_ORIGIN && !request.headers.authorization && !cookie;
  let grant: DeviceAccessGrant | undefined;
  if (url.pathname.startsWith('/api/') && !localOwner) {
    try { grant = token ? await device.request<DeviceAccessGrant | undefined>('authorizeDeviceAccess', { token }) : undefined; } catch { /* Fail closed. */ }
    if (!grant || revokedGrants.has(grant.id)) { respondJson(request, response, 401, { code: 'EAF_AUTH_REQUIRED', error: '请使用执行电脑生成的浏览器登录码连接。' }); return; }
  }
  if (request.method === 'POST' && url.pathname === '/api/device/logout') {
    if (grant) await device.request('revokeDeviceAccess', { grantId: grant.id });
    response.setHeader('Set-Cookie', `eaf_device_access=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`);
    respondJson(request, response, 200, { loggedOut: true }); return;
  }
  if (request.method === 'GET' && url.pathname === '/api/device/session') {
    respondJson(request, response, 200, { authenticated: Boolean(grant), purpose: grant?.purpose }); return;
  }
  const target = url.searchParams.get('deviceId') || 'local';
  const selectedDevice = target === localIdentity.id ? 'local' : target;
  if (grant?.purpose === 'device' && selectedDevice !== 'local') { respondJson(request, response, 403, { code: 'EAF_ACCESS_DENIED', error: '设备授权不能转发到其他机器。' }); return; }
  if (request.method === 'GET' && url.pathname === '/api/events') {
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
    subscriptions.set(response, { deviceId: selectedDevice, grantId: grant?.id, purpose: grant?.purpose });
    eventClients.add(response);
    eventClients.writeComment(response, 'connected');
    const heartbeat = setInterval(() => {
      if (grant?.expiresAt && grant.expiresAt <= Date.now()) response.end();
      else eventClients.writeComment(response, 'heartbeat');
    }, 15000);
    response.on('close', () => { clearInterval(heartbeat); eventClients.remove(response); subscriptions.delete(response); });
    response.on('error', () => { clearInterval(heartbeat); eventClients.remove(response); subscriptions.delete(response); });
    try {
      const snapshot = await device.request<import('../src/data/types.js').InteractionSnapshot>('getInteractionSnapshot', undefined, undefined, selectedDevice, token);
      eventClients.writeEvent(response, { type: 'interaction-snapshot', snapshot, ...(selectedDevice !== 'local' ? { deviceId: selectedDevice } : {}) });
    } catch { response.end(); }
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/rpc') {
    try {
      const parsed = await parseJsonBody(request);
      if (!parsed || typeof parsed.method !== 'string' || !isUiRpcMethod(parsed.method)) {
        respondJson(request, response, 400, { error: 'RPC method is required.' });
        return;
      }
      const deviceId = parsed.deviceId || 'local';
      if (grant?.purpose === 'device' && (DEVICE_WORK_EXCLUDED_METHODS.has(parsed.method) || deviceId !== 'local' && deviceId !== localIdentity.id)) {
        respondJson(request, response, 403, { code: 'EAF_ACCESS_DENIED', error: '此授权仅允许操作本台执行设备。' }); return;
      }
      const result = await device.request(parsed.method, parsed.payload, parsed.operationId, deviceId, token);
      respondJson(request, response, 200, result);
    } catch (error) {
      const detail = error as { code?: string; operationId?: string };
      respondJson(request, response, 500, { error: error instanceof Error ? error.message : 'Internal server error.', code: detail.code, operationId: detail.operationId });
    }
    return;
  }
  await serveStatic(request, url.pathname, response);
};
const safeHandleRequest = (request: IncomingMessage, response: ServerResponse) => {
  void handleRequest(request, response).catch(() => {
    if (!response.headersSent && !response.destroyed) respondJson(request, response, 400, { error: '请求无法处理，请检查地址和请求内容。' });
    else response.destroy();
  });
};
const server = (certificate && privateKey ? createHttpsServer({ cert: certificate, key: privateKey }, safeHandleRequest) : createHttpServer(safeHandleRequest)).listen(port, host, () => {
  const address = server.address();
  console.log(`EasyAIFlow web client: ${certificate ? 'https' : 'http'}://${host}:${address && typeof address === 'object' ? address.port : port} (device service runs independently)`);
});

// Closing this UI gateway leaves the device service and its tasks running.
const close = () => {
  device.close();
  server.closeAllConnections();
  server.close(() => process.exit(0));
};
process.on('SIGINT', close);
process.on('SIGTERM', close);
