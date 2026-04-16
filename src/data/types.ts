import type { AskUserQuestion } from './askUserQuestion.js';
import type { PlanModeRequest } from './planMode.js';

export type LinkedGroup = {
  id: string;
  name: string;
  color: string;
  status: 'active' | 'idle' | 'blocked';
  focus: string;
  workspace: string;
};

export type PlanModeAllowedPrompt = {
  tool: string;
  prompt: string;
};

export type SessionProvider = 'claude' | 'codex';

export type GroupParticipantId = 'claude' | 'codex';

export type GroupParticipant = {
  id: GroupParticipantId;
  label: string;
  provider: SessionProvider;
  backingSessionId: string;
  enabled: boolean;
  model?: string;
  lastAppliedRoomSeq: number;
};

export type GroupSessionMetadata =
  | {
      kind: 'room';
      nextMessageSeq: number;
      participants: GroupParticipant[];
    }
  | {
      kind: 'member';
      roomSessionId: string;
      participantId: GroupParticipantId;
      speakerLabel: string;
    };

export type SessionKind = 'standard' | 'group' | 'group_member';

export type TokenUsage = {
  contextWindow: number;
  used: number;
  input: number;
  output: number;
  cached: number;
  usedPercentage?: number;
  windowSource?: 'runtime' | 'derived' | 'unknown';
};

export type BackgroundTaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'stopped';

export type BackgroundTaskUsage = {
  totalTokens: number;
  toolUses: number;
  durationMs: number;
};

export type BackgroundTaskRecord = {
  taskId: string;
  status: BackgroundTaskStatus;
  description: string;
  toolUseId?: string;
  taskType?: string;
  workflowName?: string;
  prompt?: string;
  outputFile?: string;
  summary?: string;
  result?: string;
  lastToolName?: string;
  usage?: BackgroundTaskUsage;
  updatedAt?: number;
};

export type SessionRuntimePhase =
  | 'inactive'
  | 'running'
  | 'background'
  | 'awaiting_reply'
  | 'idle'
  | 'terminating';

export type SessionRuntimeState = {
  processActive: boolean;
  phase: SessionRuntimePhase;
  appliedEffort?: 'low' | 'medium' | 'high' | 'max';
  updatedAt?: number;
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
  provider?: SessionProvider;
  messagesLoaded?: boolean;
  model: string;
  workspace: string;
  projectId: string;
  projectName: string;
  dreamId: string;
  dreamName: string;
  claudeSessionId?: string;
  codexThreadId?: string;
  sessionKind?: SessionKind;
  hidden?: boolean;
  instructionPrompt?: string;
  group?: GroupSessionMetadata;
  groups: LinkedGroup[];
  contextReferences?: ContextReference[];
  tokenUsage: TokenUsage;
  branchSnapshot: BranchSnapshot;
};

export type SessionActivityState =
  | 'idle'
  | 'responding'
  | 'background'
  | 'awaiting_reply'
  | 'unread';

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
  seq?: number;
  timestamp: string;
  title: string;
  content: string;
  speakerId?: string;
  speakerLabel?: string;
  provider?: SessionProvider;
  sourceSessionId?: string;
  targetParticipantIds?: string[];
  recordedDiff?: DiffPayload;
  status?: 'queued' | 'streaming' | 'running' | 'background' | 'success' | 'complete' | 'error';
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

export type SessionStopResult = {
  projects: ProjectRecord[];
};

export type CloseProjectResult = {
  projects: ProjectRecord[];
  closedSessionIds: string[];
};

export type DeleteEntityResult = {
  projects: ProjectRecord[];
  deletedSessionIds: string[];
  warning?: string;
};

export type ClaudeStreamEvent =
  | {
      type: 'status';
      sessionId: string;
      sourceSessionId?: string;
      messageId: string;
      status: ConversationMessage['status'];
      title?: string;
      content?: string;
    }
  | {
      type: 'delta';
      sessionId: string;
      sourceSessionId?: string;
      messageId: string;
      delta: string;
    }
  | {
      type: 'trace';
      sessionId: string;
      sourceSessionId?: string;
      message: ConversationMessage;
    }
  | {
      type: 'permission-request';
      sessionId: string;
      sourceSessionId?: string;
      requestId: string;
      toolName: string;
      targetPath?: string;
      command?: string;
      description?: string;
      decisionReason?: string;
      sensitive: boolean;
    }
  | {
      type: 'ask-user-question';
      sessionId: string;
      sourceSessionId?: string;
      toolUseId: string;
      questions: AskUserQuestion[];
    }
  | {
      type: 'plan-mode-request';
      sessionId: string;
      sourceSessionId?: string;
      request: PlanModeRequest;
    }
  | {
      type: 'background-task';
      sessionId: string;
      sourceSessionId?: string;
      task: BackgroundTaskRecord;
    }
  | {
      type: 'runtime-state';
      sessionId: string;
      sourceSessionId?: string;
      runtime: SessionRuntimeState;
    }
  | {
      type: 'complete';
      sessionId: string;
      sourceSessionId?: string;
      messageId: string;
      content: string;
      claudeSessionId?: string;
      tokenUsage?: TokenUsage;
    }
  | {
      type: 'error';
      sessionId: string;
      sourceSessionId?: string;
      messageId: string;
      error: string;
    };

export type CliInteraction =
  | {
      kind: 'permission';
      sessionId: string;
      requestId: string;
      toolName: string;
      targetPath?: string;
      command?: string;
      description?: string;
      decisionReason?: string;
      sensitive: boolean;
    }
  | {
      kind: 'plan';
      sessionId: string;
      requestId: string;
      toolName: 'EnterPlanMode' | 'ExitPlanMode';
      plan: string;
      planFilePath?: string;
      allowedPrompts: PlanModeAllowedPrompt[];
    }
  | {
      kind: 'ask';
      sessionId: string;
      toolUseId: string;
      questions: AskUserQuestion[];
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
  model?: string;
  content: string;
  tokenUsage?: TokenUsage;
  inheritedContext: boolean;
};
