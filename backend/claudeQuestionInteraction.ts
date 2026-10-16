import type { ClaudeInteractionContext } from './claudeInteractionContext.js';
import type { ActiveClaudeRun, ClaudeInteractionState, PendingAskUserQuestion } from './claudeInteractionState.js';
import { isWritableStdin } from './claudeHelpers.js';
import { buildClaudeControlResponseLine, type ClaudeAskUserQuestionControlRequest } from '../electron/claudeControlMessages.js';
import type { AskUserQuestion, AskUserQuestionResponsePayload } from '../src/data/askUserQuestion.js';

const answeredByState = new WeakMap<ClaudeInteractionState, Set<string>>();
const answered = (state: ClaudeInteractionState) => {
  let ids = answeredByState.get(state);
  if (!ids) { ids = new Set(); answeredByState.set(state, ids); }
  return ids;
};

const deliver = (state: ClaudeInteractionState, pending: PendingAskUserQuestion) => {
  if (!pending.controlRequest || !pending.submittedResponse || !isWritableStdin(pending.activeRun.child)) return false;
  pending.activeRun.child.stdin!.write(`${buildClaudeControlResponseLine({
    requestId: pending.controlRequest.requestId,
    rawInput: {
      ...pending.controlRequest.rawInput,
      answers: pending.submittedResponse.answers,
      annotations: pending.submittedResponse.annotations,
    },
  }, 'allow')}\n`);
  state.pendingAskUserQuestions.delete(pending.toolUseId);
  return true;
};

export const registerClaudeQuestion = (
  ctx: ClaudeInteractionContext,
  state: ClaudeInteractionState,
  sessionId: string,
  activeRun: ActiveClaudeRun,
  toolUseId: string,
  questions: AskUserQuestion[],
  controlRequest?: ClaudeAskUserQuestionControlRequest,
) => {
  const existing = state.pendingAskUserQuestions.get(toolUseId);
  if (!existing && answered(state).has(toolUseId)) return;
  const pending: PendingAskUserQuestion = existing ?? { sessionId, activeRun, toolUseId, questions };
  if (controlRequest) {
    if (pending.submittedResponse && JSON.stringify(pending.questions) !== JSON.stringify(questions)) {
      pending.submittedResponse = undefined;
      answered(state).delete(toolUseId);
    }
    pending.questions = questions;
    pending.controlRequest = controlRequest;
  }
  state.pendingAskUserQuestions.set(toolUseId, pending);
  if (deliver(state, pending)) return;
  if (pending.controlRequest && !pending.presented && !pending.submittedResponse) {
    pending.presented = true;
    ctx.broadcastEvent({ type: 'ask-user-question', sessionId, toolUseId, questions: pending.questions });
  }
};

export const answerClaudeQuestion = (
  ctx: ClaudeInteractionContext,
  state: ClaudeInteractionState,
  toolUseId: string,
  response: AskUserQuestionResponsePayload,
) => {
  const completed = answered(state);
  if (completed.has(toolUseId)) return { mode: 'already-handled' as const };
  const pending = state.pendingAskUserQuestions.get(toolUseId);
  if (pending?.submittedResponse) return { mode: 'already-handled' as const };
  if (!pending || !isWritableStdin(pending.activeRun.child)) return { mode: 'missing' as const };
  // The tool-use block can reach the UI before can_use_tool. Buffer a fast
  // answer until that control request arrives; never inject a new user turn.
  pending.submittedResponse = response;
  completed.add(toolUseId);
  if (completed.size > 1024) completed.delete(completed.values().next().value!);
  const delivered = deliver(state, pending);
  ctx.broadcastEvent({ type: 'interaction-resolved', sessionId: pending.sessionId, interaction: 'ask', requestId: toolUseId });
  if (delivered) {
    const stillWaiting = [...state.pendingAskUserQuestions.values(), ...state.pendingPermissionRequests.values(), ...state.pendingPlanModeRequests.values()]
      .some((request) => request.sessionId === pending.sessionId);
    ctx.broadcastEvent({ type: 'runtime-state', sessionId: pending.sessionId, runtime: {
      processActive: true, phase: stillWaiting ? 'awaiting_reply' : 'running', updatedAt: Date.now(),
      appliedEffort: state.residentSessions.get(pending.sessionId)?.configuredEffort,
    } });
  }
  return { mode: 'interactive' as const };
};
