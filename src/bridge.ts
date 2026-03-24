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
  SessionContextUpdateResult,
  SessionCreateResult,
  SessionSummary,
  StreamworkCreateResult,
} from './data/types';

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
    claudeSessionId?: string;
    baseClaudeSessionId?: string;
  }) => Promise<BtwResponse>;
  discardBtwSession: (payload: { cwd: string; claudeSessionId?: string }) => Promise<void>;
  getFileDiff: (payload: { cwd: string; filePath: string }) => Promise<DiffPayload>;
  getPathForFile: (file: File) => string;
  getProjects: () => Promise<{
    projects: ProjectRecord[];
  }>;
  grantPathPermission: (payload: { projectRoot: string; targetPath: string }) => Promise<void>;
  respondToPermissionRequest: (payload: {
    requestId: string;
    behavior: 'allow' | 'deny';
  }) => Promise<{
    mode: 'interactive' | 'fallback' | 'missing';
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
  }) => Promise<SessionCreateResult>;
  createSession: (payload?: {
    sourceSessionId?: string;
    includeStreamworkSummary?: boolean;
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
  if (!navigator.clipboard?.writeText) {
    throw new Error('Clipboard API is unavailable in this browser.');
  }

  await navigator.clipboard.writeText(value);
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
  grantPathPermission: (payload) => callWebRpc('grantPathPermission', payload),
  respondToPermissionRequest: (payload) => callWebRpc('respondToPermissionRequest', payload),
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
  updateSessionContextReferences: (payload) => callWebRpc('updateSessionContextReferences', payload),
  renameEntity: (payload) => callWebRpc('renameEntity', payload),
  sendMessage: (payload) => callWebRpc('sendMessage', payload),
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
