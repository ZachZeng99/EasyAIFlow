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

export type HarnessRole = 'planner' | 'generator' | 'evaluator';
export type PlanModeAllowedPrompt = {
  tool: string;
  prompt: string;
};

export type HarnessMetadata = {
  role: HarnessRole;
  rootSessionId: string;
  artifactDir: string;
};

export type SessionKind = 'standard' | 'harness' | 'harness_role';

export type HarnessLifecycleStatus = 'ready' | 'running' | 'completed' | 'failed' | 'cancelled';

export type HarnessSessionState = {
  plannerSessionId: string;
  generatorSessionId: string;
  evaluatorSessionId: string;
  artifactDir: string;
  status: HarnessLifecycleStatus;
  currentOwner?: HarnessRole;
  currentStage: string;
  currentSprint: number;
  currentRound: number;
  completedSprints: number;
  maxSprints: number;
  completedTurns: number;
  totalTurns: number;
  lastDecision: string;
  summary?: string;
  updatedAt?: number;
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
  sessionKind?: SessionKind;
  hidden?: boolean;
  instructionPrompt?: string;
  harness?: HarnessMetadata;
  harnessState?: HarnessSessionState;
  groups: LinkedGroup[];
  contextReferences?: ContextReference[];
  tokenUsage: TokenUsage;
  branchSnapshot: BranchSnapshot;
};

export type SessionActivityState = 'idle' | 'responding' | 'awaiting_reply' | 'unread';

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
  recordedDiff?: DiffPayload;
  status?: 'queued' | 'streaming' | 'running' | 'success' | 'complete' | 'error';
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

export type HarnessBootstrapResult = {
  projects: ProjectRecord[];
  rootSessionId: string;
  plannerSessionId: string;
  generatorSessionId: string;
  evaluatorSessionId: string;
  artifactDir: string;
};

export type HarnessRunOptions = {
  maxSprints?: number;
  maxContractRounds?: number;
  maxImplementationRounds?: number;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
};

export type HarnessRunResult = {
  projects: ProjectRecord[];
  rootSessionId: string;
  plannerSessionId: string;
  generatorSessionId: string;
  evaluatorSessionId: string;
  artifactDir: string;
  status: 'completed' | 'failed';
  completedSprints: number;
  lastDecision: string;
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
};

export type ClaudeStreamEvent =
  | {
      type: 'status';
      sessionId: string;
      messageId: string;
      status: ConversationMessage['status'];
      title?: string;
      content?: string;
    }
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
      type: 'permission-request';
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
      type: 'ask-user-question';
      sessionId: string;
      toolUseId: string;
      questions: AskUserQuestion[];
    }
  | {
      type: 'plan-mode-request';
      sessionId: string;
      request: PlanModeRequest;
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
      type: 'harness-state';
      sessionId: string;
      state: HarnessSessionState;
    }
  | {
      type: 'error';
      sessionId: string;
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
  claudeSessionId?: string;
  model?: string;
  content: string;
  tokenUsage?: TokenUsage;
  inheritedContext: boolean;
};
