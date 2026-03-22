export type LinkedGroup = {
  id: string;
  name: string;
  color: string;
  status: 'active' | 'idle' | 'blocked';
  focus: string;
  workspace: string;
};

export type TokenUsage = {
  contextWindow: number;
  used: number;
  input: number;
  output: number;
  cached: number;
  usedPercentage?: number;
  windowSource?: 'runtime' | 'derived' | 'unknown';
};

export type ChangedFile = {
  path: string;
  status: string;
  additions: number;
  deletions: number;
};

export type DiffPayload = {
  filePath: string;
  kind: 'git' | 'untracked' | 'preview' | 'missing';
  content: string;
};

export type MessageAttachment = {
  id: string;
  name: string;
  path: string;
  mimeType: string;
  size: number;
};

export type ContextReferenceKind = 'session' | 'streamwork';

export type ContextReferenceMode = 'summary' | 'full';

export type ContextReference = {
  id: string;
  kind: ContextReferenceKind;
  label: string;
  mode: ContextReferenceMode;
  sessionId?: string;
  streamworkId?: string;
  auto?: boolean;
};

export type BranchSnapshot = {
  branch: string;
  tracking?: string;
  ahead: number;
  behind: number;
  dirty: boolean;
  changedFiles: ChangedFile[];
};

export type SessionSummary = {
  id: string;
  title: string;
  preview: string;
  timeLabel: string;
  updatedAt?: number;
  model: string;
  workspace: string;
  projectId: string;
  projectName: string;
  dreamId: string;
  dreamName: string;
  claudeSessionId?: string;
  groups: LinkedGroup[];
  contextReferences?: ContextReference[];
  tokenUsage: TokenUsage;
  branchSnapshot: BranchSnapshot;
};

export type SessionActivityState = 'idle' | 'responding' | 'unread';

export type DreamRecord = {
  id: string;
  name: string;
  isTemporary?: boolean;
  sessions: SessionSummary[];
};

export type ProjectRecord = {
  id: string;
  name: string;
  rootPath: string;
  isClosed?: boolean;
  dreams: DreamRecord[];
};

export type MessageStep = {
  id: string;
  command: string;
  status: 'queued' | 'running' | 'complete' | 'blocked';
};

export type ConversationMessageKind = 'message' | 'thinking' | 'tool_use' | 'tool_result' | 'progress' | 'error';

export type ConversationMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  kind?: ConversationMessageKind;
  timestamp: string;
  title: string;
  content: string;
  status?: 'streaming' | 'running' | 'success' | 'complete' | 'error';
  contextReferences?: ContextReference[];
  attachments?: MessageAttachment[];
  steps?: MessageStep[];
};

export type SessionRecord = SessionSummary & {
  messages: ConversationMessage[];
};

export type GitSnapshot = BranchSnapshot & {
  rootPath?: string;
  source: 'git' | 'mock';
};

export type SessionCreateResult = {
  projects: ProjectRecord[];
  session: SessionRecord;
};

export type ProjectCreateResult = {
  projects: ProjectRecord[];
  project: ProjectRecord;
  session: SessionRecord;
};

export type ProjectOpenResult = ProjectCreateResult;

export type StreamworkCreateResult = {
  projects: ProjectRecord[];
  streamwork: DreamRecord;
  session: SessionRecord;
};

export type RenameEntityResult = {
  projects: ProjectRecord[];
};

export type SessionContextUpdateResult = {
  projects: ProjectRecord[];
  session: SessionRecord;
};

export type CloseProjectResult = {
  projects: ProjectRecord[];
  closedSessionIds: string[];
};

export type DeleteEntityResult = {
  projects: ProjectRecord[];
  deletedSessionIds: string[];
};

export type ClaudeStreamEvent =
  | {
      type: 'delta';
      sessionId: string;
      messageId: string;
      delta: string;
    }
  | {
      type: 'trace';
      sessionId: string;
      message: ConversationMessage;
    }
  | {
      type: 'complete';
      sessionId: string;
      messageId: string;
      content: string;
      claudeSessionId?: string;
      tokenUsage?: TokenUsage;
    }
  | {
      type: 'error';
      sessionId: string;
      messageId: string;
      error: string;
    };

export type PendingAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  path?: string;
  dataUrl?: string;
};

export type BtwResponse = {
  claudeSessionId?: string;
  model?: string;
  content: string;
  tokenUsage?: TokenUsage;
  inheritedContext: boolean;
};
