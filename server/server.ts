import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  configureRuntimePaths,
  getRuntimePaths,
  resolveDefaultWebUserDataPath,
} from '../backend/runtimePaths.js';
import type { ClaudeInteractionContext } from '../backend/claudeInteractionContext.js';
import { createClaudeInteractionState } from '../backend/claudeInteractionState.js';
import { getGitSnapshot } from '../backend/claudeHelpers.js';
import { grantPathPermission, getConfiguredClaudeModel } from '../backend/claudeInteraction.js';
import {
  handleRespondToPermission,
  handleRespondToAskUserQuestion,
  handleRespondToPlanMode,
  handleStopSession,
  handleDisconnectSession,
  handleSendMessage,
  handleBootstrapHarness,
  handleRunHarness,
  handleBtwMessage,
  handleBtwDiscard,
  handleGetSlashCommands,
  handleBootstrapSessions,
  handleCloseProject,
  handleDeleteStreamwork,
  handleDeleteSession,
} from '../backend/claudeRpcOperations.js';
import { writeTextToSystemClipboard } from '../backend/systemClipboard.js';
import {
  bootstrapHarnessFromSession,
  createProject,
  createSession,
  createSessionInStreamwork,
  createStreamwork,
  findSession,
  renameEntity,
  reorderStreamworks,
  updateSessionContextReferences,
  flushPendingSave,
} from '../electron/sessionStore.js';
import { getFileDiff } from '../electron/fileDiff.js';
import type {
  ClaudeStreamEvent,
  ContextReference,
  PendingAttachment,
  ProjectRecord,
  SessionRecord,
  SessionSummary,
} from '../src/data/types.js';
import type { PlanModeResponsePayload } from '../src/data/planMode.js';

// ---------------------------------------------------------------------------
// Runtime paths configuration
// ---------------------------------------------------------------------------

configureRuntimePaths({
  mode: 'web',
  userDataPath: resolveDefaultWebUserDataPath({
    pathExists: (candidate) => existsSync(candidate),
  }),
  homePath: process.env.USERPROFILE ?? os.homedir(),
});

// ---------------------------------------------------------------------------
// SSE event clients
// ---------------------------------------------------------------------------

const eventClients = new Set<ServerResponse<IncomingMessage>>();

const ctx: ClaudeInteractionContext = {
  broadcastEvent: (event: ClaudeStreamEvent) => {
    const data = JSON.stringify(event);
    eventClients.forEach((client) => {
      client.write(`data: ${data}\n\n`);
    });
  },
  attachmentRoot: () => path.join(getRuntimePaths().userDataPath, 'attachments'),
  claudeSettingsPath: () => path.join(getRuntimePaths().homePath, '.claude', 'settings.json'),
  homePath: () => getRuntimePaths().homePath,
};

const state = createClaudeInteractionState();

// ---------------------------------------------------------------------------
// RPC handlers
// ---------------------------------------------------------------------------

const deriveProjectNameFromPath = (rootPath: string) => {
  const parts = rootPath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? 'Project';
};

const summarizeProjectsForWebBootstrap = (projects: ProjectRecord[]) => {
  let includedInitialVisibleSession = false;

  return projects.map((project) => ({
    ...project,
    dreams: project.dreams.map((dream) => ({
      ...dream,
      sessions: dream.sessions.map((session) => {
        const current = session as SessionRecord;
        const isVisible = !current.hidden && current.sessionKind !== 'harness_role';
        const shouldIncludeMessages = isVisible && !includedInitialVisibleSession;

        if (shouldIncludeMessages) {
          includedInitialVisibleSession = true;
        }

        return {
          ...current,
          messages: shouldIncludeMessages ? (current.messages ?? []) : [],
          messagesLoaded: shouldIncludeMessages,
        };
      }),
    })),
  }));
};

const summarizeProjectsInResult = <T extends { projects: ProjectRecord[] }>(result: T): T => ({
  ...result,
  projects: summarizeProjectsForWebBootstrap(result.projects),
});

const rpcHandlers = {
  'clipboard:write-text': async (payload: { value: string }) => {
    await writeTextToSystemClipboard(payload.value);
    return null;
  },
  getAppMeta: async () => ({
    name: 'EasyAIFlow Web',
    version: 'web',
    platform: 'web',
    defaultModel: await getConfiguredClaudeModel(ctx),
  }),
  getProjects: async () => {
    const bootstrap = await handleBootstrapSessions(state);
    return {
      ...bootstrap,
      projects: summarizeProjectsForWebBootstrap(bootstrap.projects),
    };
  },
  getSessionRecord: async (payload: { sessionId: string }) => {
    const session = await findSession(payload.sessionId);
    if (!session) {
      throw new Error('Session not found.');
    }

    return {
      ...session,
      messagesLoaded: true,
    };
  },
  getGitSnapshot: async (payload: { cwd: string }) => getGitSnapshot(payload.cwd),
  getSlashCommands: async (payload: { cwd: string; model?: string }) =>
    handleGetSlashCommands(ctx, state, payload),
  sendBtwMessage: async (payload: {
    sessionId?: string;
    cwd: string;
    prompt: string;
    model?: string;
    effort?: 'low' | 'medium' | 'high' | 'max';
    baseClaudeSessionId?: string;
  }) => handleBtwMessage(ctx, state, payload),
  discardBtwSession: async (payload: { cwd: string; claudeSessionId?: string }) => {
    await handleBtwDiscard(ctx, state, payload);
    return null;
  },
  getFileDiff: async (payload: { cwd: string; filePath: string }) => getFileDiff(payload.cwd, payload.filePath),
  grantPathPermission: async (payload: { projectRoot: string; targetPath: string }) => {
    await grantPathPermission(ctx, payload.projectRoot, payload.targetPath);
    return null;
  },
  respondToPermissionRequest: async (payload: { requestId: string; behavior: 'allow' | 'deny' }) =>
    handleRespondToPermission(ctx, state, payload),
  respondToPlanModeRequest: async (payload: {
    requestId: string;
    behavior: 'allow' | 'deny';
    choice?: 'clear-auto' | 'auto' | 'manual' | 'revise';
    notes?: string;
  }) => {
    const pending = state.pendingPlanModeRequests.get(payload.requestId);
    if (!pending) {
      return { mode: 'missing' as const };
    }

    const toolUseId = pending.request.toolUseId;
    const mode: PlanModeResponsePayload['mode'] = payload.behavior === 'allow'
      ? (payload.choice === 'manual' ? 'approve_manual' : 'approve_accept_edits')
      : 'revise';
    return handleRespondToPlanMode(ctx, state, {
      toolUseId,
      mode,
      notes: payload.notes,
    });
  },
  respondToAskUserQuestion: async (payload: {
    toolUseId: string;
    answers: Record<string, string>;
    annotations?: Record<string, { notes?: string }>;
  }) => handleRespondToAskUserQuestion(ctx, state, payload),
  respondToPlanMode: async (payload: {
    toolUseId: string;
    mode: PlanModeResponsePayload['mode'];
    selectedPromptIndex?: number;
    notes?: string;
  }) => handleRespondToPlanMode(ctx, state, payload),
  createProject: async (payload: { name?: string; rootPath: string }) =>
    summarizeProjectsInResult(
      await createProject(payload.name?.trim() || deriveProjectNameFromPath(payload.rootPath), payload.rootPath),
    ),
  closeProject: async (payload: { projectId: string }) =>
    summarizeProjectsInResult(await handleCloseProject(ctx, state, payload)),
  createStreamwork: async (payload: { projectId: string; name: string }) =>
    summarizeProjectsInResult(await createStreamwork(payload.projectId, payload.name)),
  deleteStreamwork: async (payload: { streamworkId: string }) =>
    summarizeProjectsInResult(await handleDeleteStreamwork(ctx, state, payload)),
  reorderStreamworks: async (payload: { projectId: string; sourceId: string; targetId: string }) =>
    summarizeProjectsInResult(
      await reorderStreamworks(payload.projectId, payload.sourceId, payload.targetId),
    ),
  createSession: async (payload?: { sourceSessionId?: string; includeStreamworkSummary?: boolean }) =>
    summarizeProjectsInResult(
      await createSession(payload?.sourceSessionId, Boolean(payload?.includeStreamworkSummary)),
    ),
  createSessionInStreamwork: async (payload: {
    streamworkId: string;
    name?: string;
    includeStreamworkSummary?: boolean;
  }) =>
    summarizeProjectsInResult(
      await createSessionInStreamwork(payload.streamworkId, payload.name, Boolean(payload.includeStreamworkSummary)),
    ),
  bootstrapHarness: async (payload: { sessionId: string }) =>
    handleBootstrapHarness(ctx, state, payload),
  runHarness: async (payload: {
    sessionId: string;
    maxSprints?: number;
    maxContractRounds?: number;
    maxImplementationRounds?: number;
    model?: string;
    effort?: 'low' | 'medium' | 'high' | 'max';
  }) => handleRunHarness(ctx, state, payload),
  deleteSession: async (payload: { sessionId: string }) =>
    summarizeProjectsInResult(await handleDeleteSession(ctx, state, payload)),
  updateSessionContextReferences: async (payload: { sessionId: string; references: ContextReference[] }) =>
    summarizeProjectsInResult(await updateSessionContextReferences(payload.sessionId, payload.references)),
  renameEntity: async (payload: { kind: 'project' | 'streamwork' | 'session'; id: string; name: string }) =>
    summarizeProjectsInResult(await renameEntity(payload.kind, payload.id, payload.name)),
  sendMessage: async (payload: {
    sessionId: string;
    prompt: string;
    attachments?: PendingAttachment[];
    session?: SessionSummary;
    references?: ContextReference[];
    model?: string;
    effort?: 'low' | 'medium' | 'high' | 'max';
  }) => handleSendMessage(ctx, state, payload),
  stopSessionRun: async (payload: { sessionId: string }) =>
    handleStopSession(ctx, state, payload),
  disconnectSession: async (payload: { sessionId: string }) =>
    handleDisconnectSession(ctx, state, payload),
} as const;

type RpcMethod = keyof typeof rpcHandlers;

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const parseJsonBody = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return undefined;
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
    method?: RpcMethod;
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
  const isInsideDist = targetPath.startsWith(staticRoot);

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

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const host = process.env.HOST ?? '0.0.0.0';
const port = Number(process.env.PORT ?? 8787);

createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? `localhost:${port}`}`);

  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Cache-Control': 'no-store',
    });
    response.end();
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/events') {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    response.write(': connected\n\n');
    eventClients.add(response);
    const heartbeat = setInterval(() => {
      response.write(': heartbeat\n\n');
    }, 15_000);

    request.on('close', () => {
      clearInterval(heartbeat);
      eventClients.delete(response);
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/rpc') {
    try {
      const parsed = await parseJsonBody(request);
      const method = parsed?.method;
      if (!method || !(method in rpcHandlers)) {
        respondJson(request, response, 400, { error: 'Unknown RPC method.' });
        return;
      }

      const handler = rpcHandlers[method];
      const result = await handler(parsed?.payload as never);
      respondJson(request, response, 200, result);
    } catch (error) {
      respondJson(request, response, 500, {
        error: error instanceof Error ? error.message : 'Internal server error.',
      });
    }
    return;
  }

  await serveStatic(request, url.pathname, response);
}).listen(port, host, () => {
  console.log(`EasyAIFlow web server listening on http://${host}:${port}`);
});

const killActiveRuns = () => {
  state.activeRuns.forEach((run) => {
    if (!run.child.killed) {
      run.child.kill();
    }
  });
};

process.on('SIGINT', () => {
  void flushPendingSave();
  killActiveRuns();
  process.exit(0);
});
process.on('SIGTERM', () => {
  void flushPendingSave();
  killActiveRuns();
  process.exit(0);
});
