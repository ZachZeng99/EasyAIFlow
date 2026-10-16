import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createClaudeInteractionState } from '../backend/claudeInteractionState.ts';
import { registerClaudeQuestion, answerClaudeQuestion } from '../backend/claudeQuestionInteraction.ts';
import { normalizeClaudeProtocolMessage } from '../electron/claudeProtocol.ts';
import { resolveAskUserQuestionState } from '../src/data/sessionInteraction.ts';
import { parseClaudeAskUserQuestionControlRequest } from '../electron/claudeControlMessages.ts';
import { extractAskUserQuestionResponsePayload, hasAskUserQuestionResponse } from '../src/data/askUserQuestion.ts';
import type { AskUserQuestion } from '../src/data/askUserQuestion.ts';

const run = (name: string, test: () => void) => { test(); console.log(`PASS ${name}`); };
const questions: AskUserQuestion[] = [{ question: 'A or B?', header: 'Choice', multiSelect: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }];
const fixture = () => {
  const writes: string[] = [];
  const events: Array<{ type: string; requestId?: string }> = [];
  const state = createClaudeInteractionState();
  const active = { runId: 'run', sessionId: 's', projectRoot: '.', child: { killed: false, exitCode: null, signalCode: null, stdin: { writable: true, destroyed: false, writableEnded: false, write: (value: string) => writes.push(value) } } };
  const ctx = { broadcastEvent: (event: { type: string }) => events.push(event) };
  const control = { requestId: 'native-request', toolUseId: 'tool', toolName: 'AskUserQuestion' as const, questions, rawInput: { questions, metadata: { source: 'test' } } };
  return { writes, events, state, active: active as never, ctx: ctx as never, control };
};

run('a fast answer waits for can_use_tool and is returned through updatedInput', () => {
  const f = fixture();
  registerClaudeQuestion(f.ctx, f.state, 's', f.active, 'tool', questions);
  assert.equal(f.events.filter((event) => event.type === 'ask-user-question').length, 0);
  assert.equal(answerClaudeQuestion(f.ctx, f.state, 'tool', { answers: { 'A or B?': 'A' }, annotations: {} }).mode, 'interactive');
  assert.deepEqual(f.writes, []);
  registerClaudeQuestion(f.ctx, f.state, 's', f.active, 'tool', questions, f.control);
  assert.equal(f.writes.length, 1);
  const response = JSON.parse(f.writes[0]);
  assert.equal(response.type, 'control_response');
  assert.equal(response.response.request_id, 'native-request');
  assert.deepEqual(response.response.response.updatedInput.answers, { 'A or B?': 'A' });
  assert.deepEqual(response.response.response.updatedInput.questions, questions);
  assert.deepEqual(response.response.response.updatedInput.metadata, { source: 'test' });
  assert.equal(f.state.pendingAskUserQuestions.size, 0);
});
run('an early answer is discarded if the authoritative control request changed the questions', () => {
  const f = fixture();
  registerClaudeQuestion(f.ctx, f.state, 's', f.active, 'tool', questions);
  answerClaudeQuestion(f.ctx, f.state, 'tool', { answers: { 'A or B?': 'A' }, annotations: {} });
  const changed = [{ ...questions[0], question: 'Changed question?' }];
  registerClaudeQuestion(f.ctx, f.state, 's', f.active, 'tool', changed, { ...f.control, questions: changed, rawInput: { questions: changed } });
  assert.equal(f.writes.length, 0);
  assert.equal(f.events.filter((event) => event.type === 'ask-user-question').length, 1);
  answerClaudeQuestion(f.ctx, f.state, 'tool', { answers: { 'Changed question?': 'B' }, annotations: {} });
  assert.equal(JSON.parse(f.writes[0]).response.response.updatedInput.answers['Changed question?'], 'B');
});
run('a control request waits for a real answer instead of automatically allowing an empty one', () => {
  const f = fixture();
  registerClaudeQuestion(f.ctx, f.state, 's', f.active, 'tool', questions, f.control);
  assert.deepEqual(f.writes, []);
  answerClaudeQuestion(f.ctx, f.state, 'tool', { answers: { 'A or B?': 'B' }, annotations: {} });
  assert.equal(JSON.parse(f.writes[0]).response.response.updatedInput.answers['A or B?'], 'B');
  assert.ok(f.events.some((event) => event.type === 'interaction-resolved' && event.requestId === 'tool'));
});
run('two clients cannot answer the same question twice or revive its dialog', () => {
  const f = fixture();
  registerClaudeQuestion(f.ctx, f.state, 's', f.active, 'tool', questions, f.control);
  answerClaudeQuestion(f.ctx, f.state, 'tool', { answers: { 'A or B?': 'A' }, annotations: {} });
  assert.equal(answerClaudeQuestion(f.ctx, f.state, 'tool', { answers: { 'A or B?': 'B' }, annotations: {} }).mode, 'already-handled');
  registerClaudeQuestion(f.ctx, f.state, 's', f.active, 'tool', questions);
  assert.equal(f.writes.length, 1);
  assert.equal(f.events.filter((event) => event.type === 'ask-user-question').length, 1);
});
run('question resolution clears mirrored dialogs but preserves other pending interactions', () => {
  const state = { askUserQuestion: { sessionId: 's', toolUseId: 'tool', questions }, runtime: { phase: 'awaiting_reply' as const, processActive: true } };
  assert.equal(resolveAskUserQuestionState(state, 'other'), state);
  const next = resolveAskUserQuestionState(state, 'tool');
  assert.equal(next.askUserQuestion, undefined);
  assert.equal(next.runtime?.phase, 'running');
  const blocked = resolveAskUserQuestionState({ ...state, permission: { path: 'x', sensitive: false, sessionId: 's' } }, 'tool');
  assert.equal(blocked.runtime?.phase, 'awaiting_reply');
});
run('snake-case CLI tool results are normalized without altering captured frames', () => {
  const raw = { type: 'user', tool_use_result: { answers: { 'A or B?': 'A' } } };
  const normalized = normalizeClaudeProtocolMessage(raw);
  assert.deepEqual(normalized.toolUseResult, raw.tool_use_result);
  assert.equal('toolUseResult' in raw, false);
});

run('recorded Claude 2.1.284 question frames replay through the supported control response', () => {
  const captured = JSON.parse(readFileSync(new URL('./fixtures/claude-2.1.284-question.json', import.meta.url), 'utf8'));
  const request = parseClaudeAskUserQuestionControlRequest(captured.frames[0]);
  assert.ok(request);
  const returned = normalizeClaudeProtocolMessage(captured.frames[1]);
  const answer = extractAskUserQuestionResponsePayload(returned.toolUseResult);
  assert.ok(hasAskUserQuestionResponse(answer));
  const f = fixture();
  registerClaudeQuestion(f.ctx, f.state, 's', f.active, request.toolUseId, request.questions, request);
  assert.equal(f.writes.length, 0);
  answerClaudeQuestion(f.ctx, f.state, request.toolUseId, { answers: answer.answers, annotations: answer.annotations ?? {} });
  const sent = JSON.parse(f.writes[0]);
  assert.equal(sent.response.request_id, request.requestId);
  assert.deepEqual(sent.response.response.updatedInput.answers, captured.frames[1].tool_use_result.answers);
});
