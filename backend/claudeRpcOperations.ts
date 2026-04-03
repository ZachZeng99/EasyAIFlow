import type { ClaudeInteractionContext } from './claudeInteractionContext.js';
import type { ClaudeInteractionState } from './claudeInteractionState.js';
import {
  grantPathPermission,
  getSessionInteractionSnapshots,
  runClaudePrint,
  stopSessions,
  interruptSessionTurn,
  disconnectSession,
  respondToPlanModeRequest,
  runBtwPrompt,
  deleteNativeClaudeSession,
  getConfiguredClaudeModel,
  getSlashCommands,
  runHarnessForSession,
} from './claudeInteraction.js';
import { isWritableStdin } from './claudeHelpers.js';
import {
  buildClaudeAskUserQuestionToolResultLine,
  buildClaudeControlResponseLine,
} from '../electron/claudeControlMessages.js';
import {
  bootstrapHarnessFromSession,
  closeProject,
  createProject,
  createSession,
  createSessionInStreamwork,
  createStreamwork,
  deleteSession,
  deleteStreamwork,
  getProjects,
  renameEntity,
  reorderStreamworks,
  updateSessionContextReferences,
} from '../electron/sessionStore.js';
import { stopPendingSessionMessages } from '../electron/sessionStop.js';
import { getFileDiff } from '../electron/fileDiff.js';
import { getGitSnapshot } from './claudeHelpers.js';
import type {
  ContextReference,
  PendingAttachment,
  SessionSummary,
} from '../src/data/types.js';
import type { PlanModeResponsePayload } from '../src/data/planMode.js';

export const handleRespondToPermission = async (
  ctx: ClaudeInteractionContext,
  state: ClaudeInteractionState,
  payload: { requestId: string; behavior: 'allow' | 'deny' },
) => {
  const pending = state.pendingPermissionRequests.get(payload.requestId);
  if (!pending) {
    return { mode: 'missing' as const };
  }

  state.pendingPermissionRequests.delete(payload.requestId);

  if (payload.behavior === 'allow' && pending.request.targetPath) {
    await grantPathPermission(ctx, pending.activeRun.projectRoot, pending.request.targetPath);
  }

  const stdin = pending.activeRun.child.stdin;
  if (
    stdin &&
    !pending.activeRun.child.killed &&
    !stdin.destroyed &&
    !stdin.writableEnded
  ) {
    stdin.write(`${buildClaudeControlResponseLine(pending.request, payload.behavior)}\n`);
    return { mode: 'interactive' as const };
  }

  if (payload.behavior === 'allow' && pending.request.targetPath) {
    await runClaudePrint(
      ctx,
      state,
      pending.sessionId,
      `Permission was granted for ${pending.request.targetPath}. Retry only the blocked tool action.`,
    );
    return { mode: 'fallback' as const };
  }

  return { mode: 'missing' as const };
};

export const handleRespondToAskUserQuestion = async (
  _ctx: ClaudeInteractionContext,
  state: ClaudeInteractionState,
  payload: {
    toolUseId: string;
    answers: Record<string, string>;
    annotations?: Record<string, { notes?: string }>;
  },
) => {
  const pending = state.pendingAskUserQuestions.get(payload.toolUseId);
  if (!pending) {
    return { mode: 'missing' as const };
  }

  state.pendingAskUserQuestions.delete(payload.toolUseId);
  if (!isWritableStdin(pending.activeRun.child)) {
    return { mode: 'missing' as const };
  }

  const stdin = pending.activeRun.child.stdin;
  if (!stdin) {
    return { mode: 'missing' as const };
  }

  stdin.write(
    `${buildClaudeAskUserQuestionToolResultLine({
      toolUseId: pending.toolUseId,
      questions: pending.questions,
      response: {
        answers: payload.answers,
        annotations: payload.annotations ?? {},
      },
    })}\n`,
  );
  return { mode: 'interactive' as const };
};

export const handleRespondToPlanMode = async (
  _ctx: ClaudeInteractionContext,
  state: ClaudeInteractionState,
  payload: {
    toolUseId: string;
    mode: PlanModeResponsePayload['mode'];
    selectedPromptIndex?: number;
    notes?: string;
  },
) => {
  const pending = state.pendingPlanModeRequests.get(payload.toolUseId);
  if (!pending) {
    return { mode: 'missing' as const };
  }

  if (payload.mode === 'approve_clear_context_accept_edits') {
    state.sessionPlanApprovalPreferences.set(pending.sessionId, 'accept-edits-clear-context');
  } else if (payload.mode === 'approve_accept_edits') {
    state.sessionPlanApprovalPreferences.set(pending.sessionId, 'accept-edits');
  } else {
    state.sessionPlanApprovalPreferences.set(pending.sessionId, 'manual');
  }

  state.pendingPlanModeRequests.delete(payload.toolUseId);

  // Look up the deferred control_request (stored by session, survives pending overwrites)
  const deferred = state.deferredExitPlanControlRequests.get(pending.sessionId);
  const controlRequestId = pending.controlRequestId ?? deferred?.requestId;
  const controlRawInput = pending.controlRawInput ?? deferred?.rawInput;
  if (deferred) {
    state.deferredExitPlanControlRequests.delete(pending.sessionId);
  }

  const handled = respondToPlanModeRequest(
    pending.activeRun,
    pending.request,
    {
      mode: payload.mode,
      selectedPromptIndex: payload.selectedPromptIndex,
      notes: payload.notes,
    },
    controlRequestId,
    controlRawInput,
  );
  return {
    mode: handled ? ('interactive' as const) : ('missing' as const),
  };
};

export const handleStopSession = async (
  ctx: ClaudeInteractionContext,
  state: ClaudeInteractionState,
  payload: { sessionId: string },
) => {
  const result = await interruptSessionTurn(ctx, state, payload.sessionId);
  return {
    projects: result.projects,
  };
};

export const handleDisconnectSession = async (
  ctx: ClaudeInteractionContext,
  state: ClaudeInteractionState,
  payload: { sessionId: string },
) => {
  const result = await disconnectSession(ctx, state, payload.sessionId);
  result.changedMessages.forEach((message) => {
    if (message.role === 'assistant') {
      ctx.broadcastEvent({
        type: 'status',
        sessionId: payload.sessionId,
        messageId: message.id,
        status: message.status,
        title: message.title,
        content: message.content,
      });
      return;
    }

    ctx.broadcastEvent({
      type: 'trace',
      sessionId: payload.sessionId,
      message,
    });
  });
  return {
    projects: result.projects,
  };
};

export const handleSendMessage = async (
  ctx: ClaudeInteractionContext,
  state: ClaudeInteractionState,
  payload: {
    sessionId: string;
    prompt: string;
    attachments?: PendingAttachment[];
    session?: SessionSummary;
    references?: ContextReference[];
    model?: string;
    effort?: 'low' | 'medium' | 'high' | 'max';
  },
) =>
  runClaudePrint(ctx, state, payload.sessionId, payload.prompt, payload.attachments ?? [], payload.session, {
    references: payload.references,
    model: payload.model,
    effort: payload.effort,
  });

export const handleBootstrapHarness = async (
  _ctx: ClaudeInteractionContext,
  _state: ClaudeInteractionState,
  payload: { sessionId: string },
) => bootstrapHarnessFromSession(payload.sessionId);

export const handleRunHarness = async (
  ctx: ClaudeInteractionContext,
  state: ClaudeInteractionState,
  payload: {
    sessionId: string;
    maxSprints?: number;
    maxContractRounds?: number;
    maxImplementationRounds?: number;
    model?: string;
    effort?: 'low' | 'medium' | 'high' | 'max';
  },
) => runHarnessForSession(ctx, state, payload.sessionId, payload);

export const handleBtwMessage = async (
  ctx: ClaudeInteractionContext,
  state: ClaudeInteractionState,
  payload: {
    sessionId?: string;
    cwd: string;
    prompt: string;
    model?: string;
    effort?: 'low' | 'medium' | 'high' | 'max';
    baseClaudeSessionId?: string;
  },
) => runBtwPrompt(ctx, state, payload.prompt, payload.cwd, payload);

export const handleBtwDiscard = async (
  ctx: ClaudeInteractionContext,
  _state: ClaudeInteractionState,
  payload: { cwd: string; claudeSessionId?: string },
) => {
  await deleteNativeClaudeSession(ctx, payload.cwd, payload.claudeSessionId);
};

export const handleGetAppMeta = async (
  ctx: ClaudeInteractionContext,
  appVersion: string,
) => ({
  name: 'EasyAIFlow',
  version: appVersion,
  platform: process.platform,
  defaultModel: await getConfiguredClaudeModel(ctx),
});

export const handleGetSlashCommands = async (
  ctx: ClaudeInteractionContext,
  state: ClaudeInteractionState,
  payload: { cwd: string; model?: string },
) => ({
  commands: await getSlashCommands(ctx, state, payload.cwd, payload.model),
});

export const handleBootstrapSessions = async (
  state: ClaudeInteractionState,
) => ({
  projects: await getProjects(),
  interactions: getSessionInteractionSnapshots(state),
});

export const handleCloseProject = async (
  _ctx: ClaudeInteractionContext,
  state: ClaudeInteractionState,
  payload: { projectId: string },
) => {
  const result = await closeProject(payload.projectId);
  stopSessions(state, result.closedSessionIds);
  return result;
};

export const handleDeleteStreamwork = async (
  _ctx: ClaudeInteractionContext,
  state: ClaudeInteractionState,
  payload: { streamworkId: string },
) => {
  const result = await deleteStreamwork(payload.streamworkId);
  stopSessions(state, result.deletedSessionIds);
  return result;
};

export const handleDeleteSession = async (
  _ctx: ClaudeInteractionContext,
  state: ClaudeInteractionState,
  payload: { sessionId: string },
) => {
  const result = await deleteSession(payload.sessionId);
  stopSessions(state, result.deletedSessionIds);
  return result;
};
