import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
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

const device = new DeviceServiceClient({
  dataDirectory: resolveDefaultWebUserDataPath({ pathExists: existsSync, env: process.env }),
  homeDirectory: process.env.EASYAIFLOW_HOME_DIR || process.env.USERPROFILE || os.homedir(),
});
const eventClients = createSseClientRegistry();
device.onEvent((event) => eventClients.broadcastEvent(event));
await device.connect();

const parseJsonBody = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return undefined;
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
    method?: string;
    operationId?: string;
    payload?: unknown;
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
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
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


const host = process.env.HOST ?? '0.0.0.0';
const port = Number(process.env.PORT ?? process.env.EASYAIFLOW_WEB_SERVER_PORT ?? 8887);
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? `localhost:${port}`}`);
  if (request.headers.origin) {
    let allowed = false;
    try { allowed = new URL(request.headers.origin).host === request.headers.host; } catch { /* Invalid origin. */ }
    if (!allowed) { respondJson(request, response, 403, { error: 'Cross-origin access is not allowed.' }); return; }
  }
  if (request.method === 'OPTIONS') {
    response.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' });
    response.end();
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/events') {
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
    eventClients.add(response);
    eventClients.writeComment(response, 'connected');
    const heartbeat = setInterval(() => eventClients.writeComment(response, 'heartbeat'), 15000);
    response.on('close', () => { clearInterval(heartbeat); eventClients.remove(response); });
    response.on('error', () => { clearInterval(heartbeat); eventClients.remove(response); });
    try {
      const events = await device.request<ClaudeStreamEvent[]>('getInteractionEvents');
      for (const event of events) eventClients.writeEvent(response, event);
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
      const result = await device.request(parsed.method, parsed.payload, parsed.operationId);
      respondJson(request, response, 200, result);
    } catch (error) {
      const detail = error as { code?: string; operationId?: string };
      respondJson(request, response, 500, { error: error instanceof Error ? error.message : 'Internal server error.', code: detail.code, operationId: detail.operationId });
    }
    return;
  }
  await serveStatic(request, url.pathname, response);
}).listen(port, host, () => {
  const address = server.address();
  console.log(`EasyAIFlow web client: http://${host}:${address && typeof address === 'object' ? address.port : port} (device service runs independently)`);
});

// Closing this UI gateway leaves the device service and its tasks running.
const close = () => {
  device.close();
  server.closeAllConnections();
  server.close(() => process.exit(0));
};
process.on('SIGINT', close);
process.on('SIGTERM', close);
