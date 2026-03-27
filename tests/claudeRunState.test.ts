import assert from 'node:assert/strict';
import {
  applyAssistantTextToRunState,
  createClaudeRunState,
  getRunSessionRuntimeUpdate,
  markClaudeRunCompleted,
  markRunSessionRuntimePersisted,
  noteBackgroundTaskNotificationInRunState,
  shouldCompleteClaudeRunOnClose,
} from '../electron/claudeRunState.ts';

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

run('applyAssistantTextToRunState flags a refresh when final text arrives after completion', () => {
  const completed = markClaudeRunCompleted(createClaudeRunState(), '');
  const updated = applyAssistantTextToRunState(completed, '## 源码验证结果汇总');

  assert.equal(updated.content, '## 源码验证结果汇总');
  assert.equal(updated.receivedResult, true);
  assert.equal(updated.completedContent, '');
  assert.equal(updated.needsCompletionRefresh, true);
  assert.equal(shouldCompleteClaudeRunOnClose(updated), true);
});

run('applyAssistantTextToRunState does not flag a refresh before completion', () => {
  const updated = applyAssistantTextToRunState(createClaudeRunState(), 'partial reply');

  assert.equal(updated.content, 'partial reply');
  assert.equal(updated.receivedResult, false);
  assert.equal(updated.needsCompletionRefresh, false);
  assert.equal(shouldCompleteClaudeRunOnClose(updated), true);
});

run('markClaudeRunCompleted clears any pending refresh once completion catches up', () => {
  const stale = applyAssistantTextToRunState(markClaudeRunCompleted(createClaudeRunState(), ''), 'final reply');
  const completed = markClaudeRunCompleted(stale, stale.content);

  assert.equal(completed.receivedResult, true);
  assert.equal(completed.completedContent, 'final reply');
  assert.equal(completed.needsCompletionRefresh, false);
  assert.equal(shouldCompleteClaudeRunOnClose(completed), false);
});

run('background task follow-up text does not overwrite the real assistant answer', () => {
  const completed = markClaudeRunCompleted(createClaudeRunState(), '整理完毕，以下是 PS5 安装包体的完整流程');
  const withNotification = noteBackgroundTaskNotificationInRunState(
    completed,
    '<task-notification>\n<task-id>bpu4pygpy</task-id>\n<status>completed</status>\n</task-notification>',
  );
  const updated = applyAssistantTextToRunState(
    withNotification,
    'Last background task from the exploration — all results already incorporated. Nothing new.',
  );

  assert.equal(updated.content, '整理完毕，以下是 PS5 安装包体的完整流程');
  assert.equal(updated.completedContent, '整理完毕，以下是 PS5 安装包体的完整流程');
  assert.equal(updated.needsCompletionRefresh, false);
});

run('getRunSessionRuntimeUpdate exposes newly discovered session metadata for persistence', () => {
  const update = getRunSessionRuntimeUpdate({
    ...createClaudeRunState(),
    claudeSessionId: 'session-from-control-request',
    model: 'claude-opus-4-6',
  });

  assert.deepEqual(update, {
    claudeSessionId: 'session-from-control-request',
    model: 'claude-opus-4-6',
  });
});

run('markRunSessionRuntimePersisted suppresses duplicate runtime writes until metadata changes again', () => {
  const persisted = markRunSessionRuntimePersisted({
    ...createClaudeRunState(),
    claudeSessionId: 'session-1',
    model: 'claude-opus-4-6',
  });

  assert.equal(getRunSessionRuntimeUpdate(persisted), null);

  const changed = {
    ...persisted,
    model: 'claude-sonnet-4-5',
  };

  assert.deepEqual(getRunSessionRuntimeUpdate(changed), {
    model: 'claude-sonnet-4-5',
  });
});
