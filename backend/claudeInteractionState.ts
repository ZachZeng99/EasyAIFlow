import type { spawn } from 'node:child_process';
import type {
  BackgroundTaskRecord,
  ConversationMessage,
  ContextReference,
  SessionSummary,
  TokenUsage,
} from '../src/data/types.js';
import type { ClaudePermissionControlRequest } from '../electron/claudeControlMessages.js';
import type { AskUserQuestion } from '../src/data/askUserQuestion.js';
import type { PlanModeRequest, PlanModeResponsePayload } from '../src/data/planMode.js';
import type { ClaudeRunStateCompletion } from '../electron/claudeRunState.js';
import {
  createActiveClaudeRunRegistry,
  type ActiveClaudeRun as RegisteredClaudeRun,
} from '../electron/claudeRunRegistry.js';
import { createSessionRunQueue } from '../electron/sessionRunQueue.js';
import { createSessionStopVersionRegistry } from '../electron/sessionStop.js';

export type ClaudeChildProcess = ReturnType<typeof spawn>;
export type ActiveClaudeRun = RegisteredClaudeRun<ClaudeChildProcess>;

export type PendingPermissionRequest = {
  sessionId: string;
  activeRun: ActiveClaudeRun;
  request: ClaudePermissionControlRequest;
};

export type PendingAskUserQuestion = {
  sessionId: string;
  activeRun: ActiveClaudeRun;
  toolUseId: string;
  questions: AskUserQuestion[];
};

export type PendingPlanModeRequest = {
  sessionId: string;
  activeRun: ActiveClaudeRun;
  request: PlanModeRequest;
  controlRequestId?: string;
  controlRawInput?: Record<string, unknown>;
};

export type SessionPlanApprovalPreference = 'manual' | 'accept-edits' | 'accept-edits-clear-context';

export type PerCallUsage = {
  input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
};

export type ClaudeRunState = ClaudeRunStateCompletion & {
  claudeSessionId?: string;
  model?: string;
  persistedClaudeSessionId?: string;
  persistedModel?: string;
  tokenUsage?: TokenUsage;
  lastAssistantUsage?: PerCallUsage;
  terminalError?: string;
  lastResultContent?: string;
  lastToolResultContent?: string;
  backgroundTasks: Map<string, BackgroundTaskRecord>;
  toolTraces: Map<string, ConversationMessage>;
  toolUseBlockIds: Map<number, string>;
  toolUseJsonBuffers: Map<string, string>;
};

export type ClaudePrintOptions = {
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  references?: ContextReference[];
};

export type PreparedClaudeRun = {
  sessionId: string;
  userMessageId: string;
  assistantMessageId: string;
  session: SessionSummary;
  resolvedPrompt: string;
  options?: ClaudePrintOptions;
  projects: import('../src/data/types.js').ProjectRecord[];
  assistantWasQueued: boolean;
  stopVersion: number;
};

export type ClaudeLineProcessor = {
  pushChunk: (chunk: string) => void;
  flush: () => Promise<void>;
};

export type ActiveClaudeTurn = {
  userMessageId: string;
  assistantMessageId: string;
  stopVersion: number;
  session: SessionSummary;
  runState: ClaudeRunState;
  releaseQueuedTurn: () => void;
  resolveCompletion: () => void;
  rejectCompletion: (error: unknown) => void;
};

export type BackgroundTaskOwner = {
  assistantMessageId: string;
  runState: ClaudeRunState;
};

export type ResidentPendingControlRequest = {
  subtype: 'set_model';
  nextModel?: string;
  resolve: () => void;
  reject: (error: unknown) => void;
};

export type ResidentClaudeSession = ActiveClaudeRun & {
  configuredModel?: string;
  configuredEffort?: ClaudePrintOptions['effort'];
  stdoutProcessor: ClaudeLineProcessor;
  stderrBuffer: string;
  currentTurn?: ActiveClaudeTurn;
  queuedTurns: Map<string, ActiveClaudeTurn>;
  activeOutputTurn?: ActiveClaudeTurn;
  backgroundTaskOwners: Map<string, BackgroundTaskOwner>;
  pendingControlRequests: Map<string, ResidentPendingControlRequest>;
};

export type DeferredExitPlanControl = {
  requestId: string;
  rawInput: Record<string, unknown>;
};

export type SessionBroadcastInterceptor = (event: import('../src/data/types.js').ClaudeStreamEvent) => void;

export type ClaudeInteractionState = {
  activeRuns: ReturnType<typeof createActiveClaudeRunRegistry<ClaudeChildProcess>>;
  residentSessions: Map<string, ResidentClaudeSession>;
  pendingPermissionRequests: Map<string, PendingPermissionRequest>;
  pendingAskUserQuestions: Map<string, PendingAskUserQuestion>;
  pendingPlanModeRequests: Map<string, PendingPlanModeRequest>;
  deferredExitPlanControlRequests: Map<string, DeferredExitPlanControl>;
  sessionPlanApprovalPreferences: Map<string, SessionPlanApprovalPreference>;
  sessionRunQueue: ReturnType<typeof createSessionRunQueue>;
  sessionStopVersions: ReturnType<typeof createSessionStopVersionRegistry>;
  slashCommandCache: Map<string, { commands: string[]; expiresAt: number }>;
  /** Interceptors registered per session ID; called by the resident stdout
   *  processor for every broadcastEvent so group chat can mirror events from
   *  backing sessions to their room. */
  sessionBroadcastInterceptors: Map<string, Set<SessionBroadcastInterceptor>>;
};

export const createClaudeInteractionState = (): ClaudeInteractionState => ({
  activeRuns: createActiveClaudeRunRegistry<ClaudeChildProcess>(),
  residentSessions: new Map(),
  pendingPermissionRequests: new Map(),
  pendingAskUserQuestions: new Map(),
  pendingPlanModeRequests: new Map(),
  deferredExitPlanControlRequests: new Map(),
  sessionPlanApprovalPreferences: new Map(),
  sessionRunQueue: createSessionRunQueue(),
  sessionStopVersions: createSessionStopVersionRegistry(),
  slashCommandCache: new Map(),
  sessionBroadcastInterceptors: new Map(),
});

export const addSessionBroadcastInterceptor = (
  state: ClaudeInteractionState,
  sessionId: string,
  interceptor: SessionBroadcastInterceptor,
) => {
  let set = state.sessionBroadcastInterceptors.get(sessionId);
  if (!set) {
    set = new Set();
    state.sessionBroadcastInterceptors.set(sessionId, set);
  }
  set.add(interceptor);
};

export const removeSessionBroadcastInterceptor = (
  state: ClaudeInteractionState,
  sessionId: string,
  interceptor: SessionBroadcastInterceptor,
) => {
  const set = state.sessionBroadcastInterceptors.get(sessionId);
  if (set) {
    set.delete(interceptor);
    if (set.size === 0) {
      state.sessionBroadcastInterceptors.delete(sessionId);
    }
  }
};
