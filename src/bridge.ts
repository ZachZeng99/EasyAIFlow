import type {
  BtwResponse,
  ClaudeStreamEvent,
  CloseProjectResult,
  ContextReference,
  DeleteEntityResult,
  DiffPayload,
  HarnessBootstrapResult,
  HarnessRunOptions,
  HarnessRunResult,
  PendingAttachment,
  ProjectCreateResult,
  ProjectOpenResult,
  ProjectRecord,
  RenameEntityResult,
  SessionStopResult,
  SessionContextUpdateResult,
  SessionCreateResult,
  SessionProvider,
  SessionRecord,
  SessionSummary,
  StreamworkCreateResult,
} from './data/types';
import type { PlanModeResponsePayload } from './data/planMode.js';
import type { SessionInteractionState } from './data/sessionInteraction.js';

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
    effort?: 'low' | 'medium' | 'high' | 'max';
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
  }) => Promise<SessionCreateResult>;
  bootstrapHarness: (payload: { sessionId: string }) => Promise<HarnessBootstrapResult>;
  runHarness: (payload: { sessionId: string } & HarnessRunOptions) => Promise<HarnessRunResult>;
  createSession: (payload?: {
    sourceSessionId?: string;
    includeStreamworkSummary?: boolean;
    provider?: SessionProvider;
  }) => Promise<SessionCreateResult>;
  deleteSession: (payload: { sessionId: string }) => Promise<DeleteEntityResult>;
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
    effort?: 'low' | 'medium' | 'high' | 'max';
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
    effort?: 'low' | 'medium' | 'high' | 'max';
  }) => Promise<{
    projects: ProjectRecord[];
  }>;
  switchEffort: (payload: {
    sessionId: string;
    session?: SessionSummary;
    effort: 'low' | 'medium' | 'high' | 'max';
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
    }),
  });

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

  return (await response.json()) as T;
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
  getGitSnapshot: (payload) => callWebRpc('getGitSnapshot', payload),
  getSlashCommands: (payload) => callWebRpc('getSlashCommands', payload),
  sendBtwMessage: (payload) => callWebRpc('sendBtwMessage', payload),
  discardBtwSession: (payload) => callWebRpc('discardBtwSession', payload),
  getFileDiff: (payload) => callWebRpc('getFileDiff', payload),
  getPathForFile: () => '',
  getProjects: () => callWebRpc('getProjects'),
  getSessionRecord: (payload) => callWebRpc('getSessionRecord', payload),
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
  bootstrapHarness: (payload) => callWebRpc('bootstrapHarness', payload),
  runHarness: (payload) => callWebRpc('runHarness', payload),
  createSession: (payload) => callWebRpc('createSession', payload),
  deleteSession: (payload) => callWebRpc('deleteSession', payload),
  updateSessionContextReferences: (payload) => callWebRpc('updateSessionContextReferences', payload),
  renameEntity: (payload) => callWebRpc('renameEntity', payload),
  sendMessage: (payload) => callWebRpc('sendMessage', payload),
  switchModel: (payload) => callWebRpc('switchModel', payload),
  switchEffort: (payload) => callWebRpc('switchEffort', payload),
  stopSessionRun: (payload) => callWebRpc('stopSessionRun', payload),
  disconnectSession: (payload) => callWebRpc('disconnectSession', payload),
  onClaudeEvent: (listener) => {
    const source = new EventSource('/api/events');
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
  typeof window !== 'undefined' && window.easyAIFlow ? window.easyAIFlow : webBridge;
