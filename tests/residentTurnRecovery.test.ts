import assert from 'node:assert/strict';
import {
  getAssistantMessageSnapshot,
  getResidentIdleTurnOutcome,
  isClaudeAssistantEndTurnEvent,
} from '../backend/claudeInteraction.ts';
import type { ClaudeRunState } from '../backend/claudeInteractionState.ts';
import { createClaudeRunState } from '../electron/claudeRunState.ts';

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

const makeRunState = (overrides: Partial<ClaudeRunState> = {}): ClaudeRunState => ({
  ...createClaudeRunState(),
  backgroundTasks: new Map(),
  toolTraces: new Map(),
  toolUseBlockIds: new Map(),
  toolUseJsonBuffers: new Map(),
  ...overrides,
});

run('getAssistantMessageSnapshot exposes assistant text even before a result event arrives', () => {
  const snapshot = getAssistantMessageSnapshot(
    makeRunState({
      content: 'Final answer already arrived in the assistant event.',
    }),
  );

  assert.deepEqual(snapshot, {
    content: 'Final answer already arrived in the assistant event.',
    status: 'streaming',
    title: 'Final answer already arrived in the assist',
  });
});

run('getAssistantMessageSnapshot keeps background status when async work is still active', () => {
  const snapshot = getAssistantMessageSnapshot(
    makeRunState({
      content: 'Launching the background worker now.',
      backgroundTasks: new Map([
        [
          'task-1',
          {
            taskId: 'task-1',
            status: 'running',
            description: 'Background worker',
            updatedAt: 1,
          },
        ],
      ]),
    }),
  );

  assert.equal(snapshot?.status, 'background');
});

run('getResidentIdleTurnOutcome completes turns that reached idle with visible assistant text', () => {
  const outcome = getResidentIdleTurnOutcome(
    makeRunState({
      content: 'This reply only arrived through the assistant event.',
    }),
  );

  assert.deepEqual(outcome, {
    kind: 'complete',
    content: 'This reply only arrived through the assistant event.',
  });
});

run('getResidentIdleTurnOutcome reports an error when Claude goes idle without any visible reply', () => {
  const outcome = getResidentIdleTurnOutcome(makeRunState());

  assert.deepEqual(outcome, {
    kind: 'error',
    content: 'Claude finished without returning a visible response.',
  });
});

run('getResidentIdleTurnOutcome leaves background-backed turns alone', () => {
  const outcome = getResidentIdleTurnOutcome(
    makeRunState({
      content: 'Background work was launched.',
      backgroundTasks: new Map([
        [
          'task-1',
          {
            taskId: 'task-1',
            status: 'running',
            description: 'Background worker',
            updatedAt: 1,
          },
        ],
      ]),
    }),
  );

  assert.equal(outcome, null);
});

run('isClaudeAssistantEndTurnEvent detects assistant end_turn payloads', () => {
  assert.equal(
    isClaudeAssistantEndTurnEvent({
      type: 'assistant',
      message: {
        stop_reason: 'end_turn',
      },
    }),
    true,
  );
  assert.equal(
    isClaudeAssistantEndTurnEvent({
      type: 'assistant',
      message: {
        stop_reason: 'tool_use',
      },
    }),
    false,
  );
});
