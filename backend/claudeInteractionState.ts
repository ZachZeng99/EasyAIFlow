import type { spawn } from 'node:child_process';
import type { ConversationMessage, ContextReference, SessionSummary, TokenUsage } from '../src/data/types.js';
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

export type ClaudeRunState = ClaudeRunStateCompletion & {
  claudeSessionId?: string;
  model?: string;
  persistedClaudeSessionId?: string;
  persistedModel?: string;
  tokenUsage?: TokenUsage;
  terminalError?: string;
  toolTraces: Map<string, ConversationMessage>;
  toolUseBlockIds: Map<number, string>;
  toolUseJsonBuffers: Map<string, string>;
};

export type ClaudePrintOptions = {
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
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

export type ClaudeInteractionState = {
  activeRuns: ReturnType<typeof createActiveClaudeRunRegistry<ClaudeChildProcess>>;
  pendingPermissionRequests: Map<string, PendingPermissionRequest>;
  pendingAskUserQuestions: Map<string, PendingAskUserQuestion>;
  pendingPlanModeRequests: Map<string, PendingPlanModeRequest>;
  sessionPlanApprovalPreferences: Map<string, SessionPlanApprovalPreference>;
  sessionRunQueue: ReturnType<typeof createSessionRunQueue>;
  sessionStopVersions: ReturnType<typeof createSessionStopVersionRegistry>;
  slashCommandCache: Map<string, { commands: string[]; expiresAt: number }>;
};

export const createClaudeInteractionState = (): ClaudeInteractionState => ({
  activeRuns: createActiveClaudeRunRegistry<ClaudeChildProcess>(),
  pendingPermissionRequests: new Map(),
  pendingAskUserQuestions: new Map(),
  pendingPlanModeRequests: new Map(),
  sessionPlanApprovalPreferences: new Map(),
  sessionRunQueue: createSessionRunQueue(),
  sessionStopVersions: createSessionStopVersionRegistry(),
  slashCommandCache: new Map(),
});
