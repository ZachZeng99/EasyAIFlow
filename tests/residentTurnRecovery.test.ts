import assert from 'node:assert/strict';
import {
  detachActiveBackgroundCommandsForCompletedTurn,
  getAssistantMessageSnapshot,
  getResidentIdleTurnOutcome,
  isClaudeAssistantEndTurnEvent,
  shouldFinalizeResidentAssistantEndTurn,
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

run('getResidentIdleTurnOutcome rejects partial text when Claude goes idle after tool use', () => {
  const outcome = getResidentIdleTurnOutcome(
    makeRunState({
      content: 'I found the likely cause. Let me verify the final mechanism.',
      lastAssistantStopReason: 'tool_use',
    }),
  );

  assert.deepEqual(outcome, {
    kind: 'error',
    content: 'Claude stopped after tool use without returning a final response.',
  });
});

run('getResidentIdleTurnOutcome accepts a successful result after tool use', () => {
  const outcome = getResidentIdleTurnOutcome(
    makeRunState({
      receivedResult: true,
      content: 'The completed answer arrived in the result packet.',
      lastAssistantStopReason: 'tool_use',
    }),
  );

  assert.deepEqual(outcome, {
    kind: 'complete',
    content: 'The completed answer arrived in the result packet.',
  });
});

run('getResidentIdleTurnOutcome preserves a terminal result error across idle', () => {
  const outcome = getResidentIdleTurnOutcome(
    makeRunState({
      receivedResult: true,
      content: 'Partial answer before the provider error.',
      terminalError: 'Upstream request failed.',
    }),
  );

  assert.deepEqual(outcome, {
    kind: 'error',
    content: 'Upstream request failed.',
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

run('completed assistant turns detach direct commands without detaching background agents', () => {
  const runState = makeRunState({
    content: 'The watch server is running and the requested work is complete.',
    backgroundTasks: new Map([
      [
        'watch-server',
        {
          taskId: 'watch-server',
          status: 'running',
          description: 'Background command task',
          taskType: 'command',
          updatedAt: 1,
        },
      ],
      [
        'background-agent',
        {
          taskId: 'background-agent',
          status: 'running',
          description: 'Background research agent',
          taskType: 'local_agent',
          updatedAt: 2,
        },
      ],
    ]),
  });

  const detached = detachActiveBackgroundCommandsForCompletedTurn(runState);

  assert.deepEqual(detached.map((task) => task.taskId), ['watch-server']);
  assert.equal(runState.backgroundTasks.get('watch-server')?.detached, true);
  assert.equal(runState.backgroundTasks.get('background-agent')?.detached, undefined);
  assert.equal(getResidentIdleTurnOutcome(runState), null);
});

run('detaching the only direct command lets a completed assistant turn settle', () => {
  const runState = makeRunState({
    content: 'The server is back up and serving requests.',
    backgroundTasks: new Map([
      [
        'watch-server',
        {
          taskId: 'watch-server',
          status: 'running',
          description: 'Background command task',
          taskType: 'command',
          updatedAt: 1,
        },
      ],
    ]),
  });

  detachActiveBackgroundCommandsForCompletedTurn(runState);

  assert.deepEqual(getResidentIdleTurnOutcome(runState), {
    kind: 'complete',
    content: 'The server is back up and serving requests.',
  });
});

run('getResidentIdleTurnOutcome keeps prior assistant text instead of replacing it with raw task output', () => {
  const outcome = getResidentIdleTurnOutcome(
    makeRunState({
      receivedResult: true,
      content: 'I started the comparison and will post the summary once it settles.',
      lastToolResultContent: 'total 8\r\n-rw-r--r-- foo.txt\r\n-rw-r--r-- bar.txt',
    }),
  );

  assert.deepEqual(outcome, {
    kind: 'complete',
    content: 'I started the comparison and will post the summary once it settles.',
  });
});

run('getResidentIdleTurnOutcome treats tool-only background completion as a silent settle', () => {
  const outcome = getResidentIdleTurnOutcome(
    makeRunState({
      receivedResult: true,
      lastToolResultContent: 'total 8\r\n-rw-r--r-- foo.txt\r\n-rw-r--r-- bar.txt',
    }),
  );

  assert.deepEqual(outcome, {
    kind: 'silent',
  });
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

run('shouldFinalizeResidentAssistantEndTurn ignores thinking-only end_turn packets', () => {
  assert.equal(
    shouldFinalizeResidentAssistantEndTurn(
      {
        type: 'assistant',
        message: {
          stop_reason: 'end_turn',
        },
      },
      makeRunState({
        lastToolResultContent: '| Export | `texture` |',
      }),
    ),
    false,
  );

  assert.equal(
    shouldFinalizeResidentAssistantEndTurn(
      {
        type: 'assistant',
        message: {
          stop_reason: 'end_turn',
        },
      },
      makeRunState({
        content: 'This is the real assistant reply.',
      }),
    ),
    true,
  );
});
