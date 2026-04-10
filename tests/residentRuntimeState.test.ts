import assert from 'node:assert/strict';
import { syncResidentRuntimeState } from '../backend/claudeInteraction.ts';
import {
  createClaudeInteractionState,
  type ClaudeRunState,
  type ResidentClaudeSession,
} from '../backend/claudeInteractionState.ts';
import type { ClaudeInteractionContext } from '../backend/claudeInteractionContext.ts';
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

run('syncResidentRuntimeState returns resident sessions to idle after stopped background tasks settle', () => {
  const state = createClaudeInteractionState();
  const events: Array<{ type: string; runtime?: { phase?: string; processActive?: boolean } }> = [];
  const ctx: ClaudeInteractionContext = {
    broadcastEvent: (event) => {
      events.push(event);
    },
    attachmentRoot: () => 'D:\\AIAgent\\EasyAIFlow',
    claudeSettingsPath: () => 'D:\\AIAgent\\EasyAIFlow\\.claude.json',
    homePath: () => 'D:\\AIAgent\\EasyAIFlow',
  };

  const runState: ClaudeRunState = {
    ...createClaudeRunState(),
    backgroundTasks: new Map([
      [
        'task-1',
        {
          taskId: 'task-1',
          status: 'stopped',
          description: 'Stopped background agent',
          updatedAt: 1,
        },
      ],
    ]),
    toolTraces: new Map(),
    toolUseBlockIds: new Map(),
    toolUseJsonBuffers: new Map(),
  };

  const resident = {
    child: {
      killed: false,
      exitCode: null,
      signalCode: null,
    },
    configuredEffort: 'max',
    currentTurn: undefined,
    activeOutputTurn: undefined,
    backgroundTaskOwners: new Map([
      [
        'task-1',
        {
          assistantMessageId: 'assistant-1',
          runState,
        },
      ],
    ]),
    queuedTurns: new Map(),
  } as unknown as ResidentClaudeSession;

  syncResidentRuntimeState(ctx, state, 'session-1', resident);

  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'runtime-state');
  assert.equal(events[0]?.runtime?.processActive, true);
  assert.equal(events[0]?.runtime?.phase, 'idle');
  assert.equal(events[0]?.runtime?.appliedEffort, 'max');
});

run('syncResidentRuntimeState keeps handoff turns in background instead of treating them as foreground runs', () => {
  const state = createClaudeInteractionState();
  const events: Array<{ type: string; runtime?: { phase?: string; processActive?: boolean } }> = [];
  const ctx: ClaudeInteractionContext = {
    broadcastEvent: (event) => {
      events.push(event);
    },
    attachmentRoot: () => 'D:\\AIAgent\\EasyAIFlow',
    claudeSettingsPath: () => 'D:\\AIAgent\\EasyAIFlow\\.claude.json',
    homePath: () => 'D:\\AIAgent\\EasyAIFlow',
  };

  const runState: ClaudeRunState = {
    ...createClaudeRunState(),
    backgroundTasks: new Map([
      [
        'task-2',
        {
          taskId: 'task-2',
          status: 'running',
          description: 'Background agent',
          updatedAt: 2,
        },
      ],
    ]),
    toolTraces: new Map(),
    toolUseBlockIds: new Map(),
    toolUseJsonBuffers: new Map(),
  };

  const resident = {
    child: {
      killed: false,
      exitCode: null,
      signalCode: null,
    },
    configuredEffort: 'high',
    currentTurn: undefined,
    activeOutputTurn: {
      assistantMessageId: 'assistant-2',
      runState,
    },
    backgroundTaskOwners: new Map(),
    queuedTurns: new Map(),
  } as unknown as ResidentClaudeSession;

  syncResidentRuntimeState(ctx, state, 'session-2', resident);

  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'runtime-state');
  assert.equal(events[0]?.runtime?.processActive, true);
  assert.equal(events[0]?.runtime?.phase, 'background');
  assert.equal(events[0]?.runtime?.appliedEffort, 'high');
});
