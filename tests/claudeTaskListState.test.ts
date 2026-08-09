import assert from 'node:assert/strict';
import { createClaudeTaskListCompletionTracker } from '../electron/claudeTaskListState.ts';

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

const consumePromptToolResult = (
  tracker: ReturnType<typeof createClaudeTaskListCompletionTracker>,
  promptId: string,
  toolUseResult: Record<string, unknown>,
) => {
  tracker.consume({
    type: 'user',
    promptId,
    toolUseResult,
  });
};

run('detaches a background process after every task created by its prompt completes', () => {
  const tracker = createClaudeTaskListCompletionTracker(['editor-process']);

  consumePromptToolResult(tracker, 'prompt-editor', { task: { id: '3' } });
  consumePromptToolResult(tracker, 'prompt-editor', { task: { id: '4' } });
  consumePromptToolResult(tracker, 'prompt-editor', {
    backgroundTaskId: 'editor-process',
  });
  consumePromptToolResult(tracker, 'prompt-editor', {
    success: true,
    taskId: '3',
    statusChange: { from: 'in_progress', to: 'completed' },
  });
  consumePromptToolResult(tracker, 'prompt-editor', {
    success: true,
    taskId: '4',
    statusChange: { from: 'pending', to: 'completed' },
  });

  assert.deepEqual([...tracker.getDetachedBackgroundTaskIds()], ['editor-process']);
});

run('keeps background work active while any task from its prompt is incomplete', () => {
  const tracker = createClaudeTaskListCompletionTracker(['build-process']);

  consumePromptToolResult(tracker, 'prompt-build', { task: { id: '1' } });
  consumePromptToolResult(tracker, 'prompt-build', { task: { id: '2' } });
  consumePromptToolResult(tracker, 'prompt-build', {
    backgroundTaskId: 'build-process',
  });
  consumePromptToolResult(tracker, 'prompt-build', {
    success: true,
    taskId: '1',
    statusChange: { from: 'in_progress', to: 'completed' },
  });

  assert.deepEqual([...tracker.getDetachedBackgroundTaskIds()], []);
});

run('does not combine completion state from unrelated prompts', () => {
  const tracker = createClaudeTaskListCompletionTracker(['monitor-process']);

  consumePromptToolResult(tracker, 'prompt-monitor', {
    backgroundTaskId: 'monitor-process',
  });
  consumePromptToolResult(tracker, 'prompt-other', { task: { id: '8' } });
  consumePromptToolResult(tracker, 'prompt-other', {
    success: true,
    taskId: '8',
    statusChange: { from: 'pending', to: 'completed' },
  });

  assert.deepEqual([...tracker.getDetachedBackgroundTaskIds()], []);
});

run('detaches a direct background command after the main assistant turn ends', () => {
  const tracker = createClaudeTaskListCompletionTracker(['watch-server']);

  tracker.consume({
    type: 'user',
    isSidechain: false,
    promptId: 'prompt-watch',
    toolUseResult: { backgroundTaskId: 'watch-server' },
  });
  tracker.consume({
    type: 'assistant',
    isSidechain: false,
    message: {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'The server is running and the requested work is done.' }],
    },
  });

  assert.deepEqual([...tracker.getDetachedBackgroundTaskIds()], ['watch-server']);
});

run('does not let a sidechain end turn detach a main-thread command', () => {
  const tracker = createClaudeTaskListCompletionTracker(['watch-server']);

  tracker.consume({
    type: 'user',
    isSidechain: false,
    promptId: 'prompt-watch',
    toolUseResult: { backgroundTaskId: 'watch-server' },
  });
  tracker.consume({
    type: 'assistant',
    isSidechain: true,
    message: {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'A sidechain finished.' }],
    },
  });

  assert.deepEqual([...tracker.getDetachedBackgroundTaskIds()], []);
});
