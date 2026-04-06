import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stopAllCodexRuns } from '../backend/codexInteraction.js';
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
  handleSwitchEffort,
  handleSwitchModel,
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
  getProjects,
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
  getProjects: async () => handleBootstrapSessions(state),
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
    createProject(payload.name?.trim() || deriveProjectNameFromPath(payload.rootPath), payload.rootPath),
  closeProject: async (payload: { projectId: string }) =>
    handleCloseProject(ctx, state, payload),
  createStreamwork: async (payload: { projectId: string; name: string }) =>
    createStreamwork(payload.projectId, payload.name),
  deleteStreamwork: async (payload: { streamworkId: string }) =>
    handleDeleteStreamwork(ctx, state, payload),
  reorderStreamworks: async (payload: { projectId: string; sourceId: string; targetId: string }) =>
    reorderStreamworks(payload.projectId, payload.sourceId, payload.targetId),
  createSession: async (payload?: {
    sourceSessionId?: string;
    includeStreamworkSummary?: boolean;
    provider?: import('../src/data/types.js').SessionProvider;
  }) =>
    createSession(
      payload?.sourceSessionId,
      Boolean(payload?.includeStreamworkSummary),
      payload?.provider,
    ),
  createSessionInStreamwork: async (payload: {
    streamworkId: string;
    name?: string;
    includeStreamworkSummary?: boolean;
    provider?: import('../src/data/types.js').SessionProvider;
  }) =>
    createSessionInStreamwork(
      payload.streamworkId,
      payload.name,
      Boolean(payload.includeStreamworkSummary),
      payload.provider,
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
    handleDeleteSession(ctx, state, payload),
  updateSessionContextReferences: async (payload: { sessionId: string; references: ContextReference[] }) =>
    updateSessionContextReferences(payload.sessionId, payload.references),
  renameEntity: async (payload: { kind: 'project' | 'streamwork' | 'session'; id: string; name: string }) =>
    renameEntity(payload.kind, payload.id, payload.name),
  sendMessage: async (payload: {
    sessionId: string;
    prompt: string;
    attachments?: PendingAttachment[];
    session?: SessionSummary;
    references?: ContextReference[];
    model?: string;
    effort?: 'low' | 'medium' | 'high' | 'max';
  }) => handleSendMessage(ctx, state, payload),
  switchModel: async (payload: {
    sessionId: string;
    session?: SessionSummary;
    model: string;
    effort?: 'low' | 'medium' | 'high' | 'max';
  }) => handleSwitchModel(ctx, state, payload),
  switchEffort: async (payload: {
    sessionId: string;
    session?: SessionSummary;
    effort: 'low' | 'medium' | 'high' | 'max';
  }) => handleSwitchEffort(ctx, state, payload),
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

const respondJson = (response: ServerResponse<IncomingMessage>, statusCode: number, payload: unknown) => {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(payload));
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

const serveStatic = async (requestPath: string, response: ServerResponse<IncomingMessage>) => {
  const sanitizedPath = requestPath === '/' ? '/index.html' : requestPath;
  const targetPath = path.resolve(staticRoot, `.${sanitizedPath}`);
  const isInsideDist = targetPath.startsWith(staticRoot);

  if (isInsideDist) {
    try {
      const info = await stat(targetPath);
      if (info.isFile()) {
        const body = await readFile(targetPath);
        response.writeHead(200, {
          'Content-Type': MIME_TYPES[path.extname(targetPath)] ?? 'application/octet-stream',
          'Cache-Control': 'no-cache',
        });
        response.end(body);
        return true;
      }
    } catch {
      // Fall through to SPA index handling.
    }
  }

  try {
    const indexHtml = await readFile(path.join(staticRoot, 'index.html'));
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    response.end(indexHtml);
    return true;
  } catch {
    response.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
    });
    response.end('EasyAIFlow web API is running. Build the client with "npm run build:web" to serve the UI here.');
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
        respondJson(response, 400, { error: 'Unknown RPC method.' });
        return;
      }

      const handler = rpcHandlers[method];
      const result = await handler(parsed?.payload as never);
      respondJson(response, 200, result);
    } catch (error) {
      respondJson(response, 500, {
        error: error instanceof Error ? error.message : 'Internal server error.',
      });
    }
    return;
  }

  await serveStatic(url.pathname, response);
}).listen(port, host, () => {
  console.log(`EasyAIFlow web server listening on http://${host}:${port}`);
});

const killActiveRuns = () => {
  stopAllCodexRuns();
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
