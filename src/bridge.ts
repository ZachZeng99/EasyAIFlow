import type {
  BtwResponse,
  ClaudeStreamEvent,
  CloseProjectResult,
  ContextReference,
  DeleteEntityResult,
  DiffPayload,
  PendingAttachment,
  ProjectCreateResult,
  ProjectOpenResult,
  ProjectRecord,
  RenameEntityResult,
  SessionStopResult,
  SessionContextUpdateResult,
  SessionCreateResult,
  SessionKind,
  SessionMessagePage,
  SessionProvider,
  SessionRecord,
  SessionSummary,
  StreamworkCreateResult,
} from './data/types';
import type { PlanModeResponsePayload } from './data/planMode.js';
import type { SessionInteractionState } from './data/sessionInteraction.js';
import { withOperationIdentity } from './data/operationIdentity.js';
import type { ProviderModelCatalog } from './data/providerModels.js';

type RpcErrorShape = {
  error?: string;
};

export type EasyAIFlowBridge = {
  runtime: 'desktop' | 'web';
  writeClipboardText: (value: string) => Promise<void>;
  getAppMeta: () => Promise<{
    name: string;
    version: string;
    platform: string;
    defaultModel?: string;
  }>;
  getGitSnapshot: (cwd: string) => Promise<{
    branch: string;
    tracking?: string;
    ahead: number;
    behind: number;
    dirty: boolean;
    changedFiles: Array<{
      path: string;
      status: string;
      additions: number;
      deletions: number;
    }>;
    rootPath?: string;
    source: 'git' | 'mock';
  } | null>;
  getSlashCommands: (payload: { cwd: string; model?: string }) => Promise<{
    commands: string[];
  }>;
  sendBtwMessage: (payload: {
    sessionId?: string;
    cwd: string;
    prompt: string;
    model?: string;
    effort?: string;
    baseClaudeSessionId?: string;
  }) => Promise<BtwResponse>;
  discardBtwSession: (payload: { cwd: string; claudeSessionId?: string }) => Promise<void>;
  getFileDiff: (payload: { cwd: string; filePath: string }) => Promise<DiffPayload>;
  getPathForFile: (file: File) => string;
  getProjects: () => Promise<{
    projects: ProjectRecord[];
    interactions?: Record<string, SessionInteractionState>;
  }>;
  getSessionRecord: (payload: { sessionId: string }) => Promise<SessionRecord>;
  getProviderModels: (payload: { provider: SessionProvider; cwd: string; force?: boolean }) => Promise<ProviderModelCatalog>;
  getOperationStatus: (payload: { operationId: string }) => Promise<{
    id: string; method: string; status: 'started' | 'completed' | 'uncertain'; result?: unknown; error?: string;
  } | null>;
  getSessionHistoryRevision: (payload: { sessionId: string }) => Promise<{
    revision?: string;
  }>;
  getSessionMessagePage: (payload: {
    sessionId: string;
    before?: string;
  }) => Promise<SessionMessagePage>;
  grantPathPermission: (payload: { projectRoot: string; targetPath: string }) => Promise<void>;
  respondToPermissionRequest: (payload: {
    requestId: string;
    behavior: 'allow' | 'deny';
  }) => Promise<{
    mode: 'interactive' | 'fallback' | 'missing';
  }>;
  respondToPlanModeRequest: (payload: {
    requestId: string;
    behavior: 'allow' | 'deny';
    choice?: 'clear-auto' | 'auto' | 'manual' | 'revise';
    notes?: string;
  }) => Promise<{
    mode: 'interactive' | 'missing';
  }>;
  respondToAskUserQuestion: (payload: {
    toolUseId: string;
    answers: Record<string, string>;
    annotations?: Record<string, { notes?: string }>;
  }) => Promise<{
    mode: 'interactive' | 'missing';
  }>;
  respondToPlanMode: (payload: {
    toolUseId: string;
    mode: PlanModeResponsePayload['mode'];
    selectedPromptIndex?: number;
    notes?: string;
  }) => Promise<{
    mode: 'interactive' | 'missing';
  }>;
  openProjectDirectory: () => Promise<ProjectOpenResult | null>;
  closeProject: (payload: { projectId: string }) => Promise<CloseProjectResult>;
  createProject: (payload: { name: string; rootPath: string }) => Promise<ProjectCreateResult>;
  createStreamwork: (payload: { projectId: string; name: string }) => Promise<StreamworkCreateResult>;
  deleteStreamwork: (payload: { streamworkId: string }) => Promise<DeleteEntityResult>;
  reorderStreamworks: (payload: {
    projectId: string;
    sourceId: string;
    targetId: string;
  }) => Promise<RenameEntityResult>;
  createSessionInStreamwork: (payload: {
    streamworkId: string;
    name?: string;
    includeStreamworkSummary?: boolean;
    provider?: SessionProvider;
    sessionKind?: SessionKind;
  }) => Promise<SessionCreateResult>;
  createSession: (payload?: {
    sourceSessionId?: string;
    includeStreamworkSummary?: boolean;
    provider?: SessionProvider;
    sessionKind?: SessionKind;
  }) => Promise<SessionCreateResult>;
  deleteSession: (payload: { sessionId: string }) => Promise<DeleteEntityResult>;
  setSessionPinned: (payload: { sessionId: string; pinned: boolean }) => Promise<RenameEntityResult>;
  updateSessionContextReferences: (payload: {
    sessionId: string;
    references: ContextReference[];
  }) => Promise<SessionContextUpdateResult>;
  renameEntity: (payload: {
    kind: 'project' | 'streamwork' | 'session';
    id: string;
    name: string;
  }) => Promise<RenameEntityResult>;
  sendMessage: (payload: {
    sessionId: string;
    prompt: string;
    attachments?: PendingAttachment[];
    session?: SessionSummary;
    references?: ContextReference[];
    model?: string;
    effort?: string;
  }) => Promise<{
    projects: ProjectRecord[];
    queued: {
      sessionId: string;
      userMessageId: string;
      assistantMessageId: string;
    };
  }>;
  switchModel: (payload: {
    sessionId: string;
    session?: SessionSummary;
    model: string;
    effort?: string;
  }) => Promise<{
    projects: ProjectRecord[];
  }>;
  switchEffort: (payload: {
    sessionId: string;
    session?: SessionSummary;
    effort: string;
  }) => Promise<{
    projects: ProjectRecord[];
  }>;
  stopSessionRun: (payload: { sessionId: string }) => Promise<SessionStopResult>;
  disconnectSession: (payload: { sessionId: string }) => Promise<SessionStopResult>;
  onClaudeEvent: (listener: (event: ClaudeStreamEvent) => void) => () => void;
};

const callWebRpc = async <T>(method: string, payload?: unknown): Promise<T> => {
  const response = await fetch('/api/rpc', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      method,
      payload,
      operationId: payload && typeof payload === 'object' ? (payload as { operationId?: string }).operationId : undefined,
    }),
  }).catch(() => { throw new Error('EAF_TRANSPORT_RETRYABLE: 与执行服务的连接中断，请求将使用原操作 ID 重试。'); });

  if (!response.ok) {
    let message = `Request failed with status ${response.status}`;
    try {
      const parsed = (await response.json()) as RpcErrorShape;
      if (parsed.error) {
        message = parsed.error;
      }
    } catch {
      // Keep the default status-based message.
    }
    throw new Error(message);
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new Error('EAF_TRANSPORT_RETRYABLE: 响应未完整收到，请求将使用原操作 ID 重试。');
  }
};

const writeClipboardText = async (value: string) => {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Fall back to the local web runtime when the browser blocks clipboard access.
    }
  }

  await callWebRpc('clipboard:write-text', { value });
};

const webBridge: EasyAIFlowBridge = {
  runtime: 'web',
  writeClipboardText,
  getAppMeta: () => callWebRpc('getAppMeta'),
  getGitSnapshot: (cwd) => callWebRpc('getGitSnapshot', { cwd }),
  getSlashCommands: (payload) => callWebRpc('getSlashCommands', payload),
  sendBtwMessage: (payload) => callWebRpc('sendBtwMessage', payload),
  discardBtwSession: (payload) => callWebRpc('discardBtwSession', payload),
  getFileDiff: (payload) => callWebRpc('getFileDiff', payload),
  getPathForFile: () => '',
  getProjects: () => callWebRpc('getProjects'),
  getSessionRecord: (payload) => callWebRpc('getSessionRecord', payload),
  getProviderModels: (payload) => callWebRpc('getProviderModels', payload),
  getOperationStatus: (payload) => callWebRpc('getOperationStatus', payload),
  getSessionHistoryRevision: (payload) => callWebRpc('getSessionHistoryRevision', payload),
  getSessionMessagePage: (payload) => callWebRpc('getSessionMessagePage', payload),
  grantPathPermission: (payload) => callWebRpc('grantPathPermission', payload),
  respondToPermissionRequest: (payload) => callWebRpc('respondToPermissionRequest', payload),
  respondToPlanModeRequest: (payload) => callWebRpc('respondToPlanModeRequest', payload),
  respondToAskUserQuestion: (payload) => callWebRpc('respondToAskUserQuestion', payload),
  respondToPlanMode: (payload) => callWebRpc('respondToPlanMode', payload),
  openProjectDirectory: async () => {
    throw new Error('Web runtime does not support the native directory picker.');
  },
  closeProject: (payload) => callWebRpc('closeProject', payload),
  createProject: (payload) => callWebRpc('createProject', payload),
  createStreamwork: (payload) => callWebRpc('createStreamwork', payload),
  deleteStreamwork: (payload) => callWebRpc('deleteStreamwork', payload),
  reorderStreamworks: (payload) => callWebRpc('reorderStreamworks', payload),
  createSessionInStreamwork: (payload) => callWebRpc('createSessionInStreamwork', payload),
  createSession: (payload) => callWebRpc('createSession', payload),
  deleteSession: (payload) => callWebRpc('deleteSession', payload),
  setSessionPinned: (payload) => callWebRpc('setSessionPinned', payload),
  updateSessionContextReferences: (payload) => callWebRpc('updateSessionContextReferences', payload),
  renameEntity: (payload) => callWebRpc('renameEntity', payload),
  sendMessage: (payload) => callWebRpc('sendMessage', payload),
  switchModel: (payload) => callWebRpc('switchModel', payload),
  switchEffort: (payload) => callWebRpc('switchEffort', payload),
  stopSessionRun: (payload) => callWebRpc('stopSessionRun', payload),
  disconnectSession: (payload) => callWebRpc('disconnectSession', payload),
  onClaudeEvent: (listener) => {
    const source = new EventSource('/api/events');
    source.onopen = () => {
      listener({ type: 'interaction-sync' });
    };
    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as ClaudeStreamEvent;
        listener(payload);
      } catch {
        // Ignore malformed SSE payloads.
      }
    };
    return () => {
      source.close();
    };
  },
};

export const bridge: EasyAIFlowBridge =
  withOperationIdentity(typeof window !== 'undefined' && window.easyAIFlow ? window.easyAIFlow : webBridge);
