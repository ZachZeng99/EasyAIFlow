import assert from 'node:assert/strict';
import {
  applyAssistantTextToRunState,
  createClaudeRunState,
  getRunSessionRuntimeUpdate,
  isIgnorableBackgroundTaskFollowupText,
  markClaudeRunCompleted,
  markRunSessionRuntimePersisted,
  noteBackgroundTaskNotificationInRunState,
  stripLeadingBackgroundTaskFollowupText,
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

run('cleanup-only background follow-up text is ignorable', () => {
  assert.equal(
    isIgnorableBackgroundTaskFollowupText('(Background task cleaned up — no action needed.)'),
    true,
  );
  assert.equal(
    isIgnorableBackgroundTaskFollowupText('(Background task completed — that was from the earlier interrupted search, no action needed.)'),
    true,
  );
  assert.equal(
    isIgnorableBackgroundTaskFollowupText('后台任务清理完了。需要我帮你做什么就说。'),
    true,
  );
  assert.equal(
    isIgnorableBackgroundTaskFollowupText(
      '(Background task completed - the ue_capture_query.py script finished, but we already got all the data we needed via direct grep on the CSVs.)',
    ),
    true,
  );
});

run('stripLeadingBackgroundTaskFollowupText removes a leading background note when a real answer follows', () => {
  const stripped = stripLeadingBackgroundTaskFollowupText(
    '(Background task completed - the ue_capture_query.py script finished, but we already got all the data we needed via direct grep on the CSVs.)\n\n上面的分析已经找到了根因：UseHardwareRayTracedRadianceCache() 中有 OR 条件会绕过 CVar。',
  );

  assert.equal(
    stripped,
    '上面的分析已经找到了根因：UseHardwareRayTracedRadianceCache() 中有 OR 条件会绕过 CVar。',
  );
});

run('cleanup follow-up text does not overwrite an unfinished assistant reply', () => {
  const pending = noteBackgroundTaskNotificationInRunState(
    {
      ...createClaudeRunState(),
      content: '## Lumen Translucency GI Volume 完整管线',
    },
    '<task-notification>\n<task-id>bobjwstge</task-id>\n<status>killed</status>\n</task-notification>',
  );
  const updated = applyAssistantTextToRunState(
    pending,
    '(Background task cleaned up — no action needed.)',
  );

  assert.equal(updated.content, '## Lumen Translucency GI Volume 完整管线');
  assert.equal(updated.backgroundTaskNotificationPending, false);
});

run('cleanup follow-up text does not overwrite a pending tool-result-backed answer', () => {
  const pending = noteBackgroundTaskNotificationInRunState(
    {
      ...createClaudeRunState(),
      lastToolResultContent: '## COMPREHENSIVE DEEP DIVE: UE5 Lumen Translucency GI Volume System',
    },
    '<task-notification>\n<task-id>bobjwstge</task-id>\n<status>killed</status>\n</task-notification>',
  );
  const updated = applyAssistantTextToRunState(
    pending,
    '(Background task cleaned up — no action needed.)',
  );

  assert.equal(
    (updated as typeof pending).lastToolResultContent,
    '## COMPREHENSIVE DEEP DIVE: UE5 Lumen Translucency GI Volume System',
  );
  assert.equal(updated.content, '');
  assert.equal(updated.backgroundTaskNotificationPending, false);
});

run('background task follow-up text updates unfinished assistant messages', () => {
  const withNotification = noteBackgroundTaskNotificationInRunState(
    createClaudeRunState(),
    '<task-notification>\n<task-id>bpu4pygpy</task-id>\n<status>completed</status>\n</task-notification>',
  );
  const updated = applyAssistantTextToRunState(
    withNotification,
    'light 的 batch 条件是可以提前预测多个动作的结果，不需要每步都重新观察页面。',
  );

  assert.equal(
    updated.content,
    'light 的 batch 条件是可以提前预测多个动作的结果，不需要每步都重新观察页面。',
  );
  assert.equal(updated.backgroundTaskNotificationPending, false);
});

run('background task follow-up prefix is stripped when the assistant continues with a fresh answer', () => {
  const withNotification = noteBackgroundTaskNotificationInRunState(
    createClaudeRunState(),
    '<task-notification>\n<task-id>bpu4pygpy</task-id>\n<status>completed</status>\n</task-notification>',
  );
  const updated = applyAssistantTextToRunState(
    withNotification,
    '(Background task completed - the ue_capture_query.py script finished, but we already got all the data we needed via direct grep on the CSVs.)\n\n上面的分析已经找到了根因：UseHardwareRayTracedRadianceCache() 中有 OR 条件会绕过 CVar。',
  );

  assert.equal(
    updated.content,
    '上面的分析已经找到了根因：UseHardwareRayTracedRadianceCache() 中有 OR 条件会绕过 CVar。',
  );
  assert.equal(updated.backgroundTaskNotificationPending, false);
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
