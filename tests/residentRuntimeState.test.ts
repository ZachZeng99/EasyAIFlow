import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getSessionInteractionSnapshots,
  syncResidentRuntimeState,
} from '../backend/claudeInteraction.ts';
import {
  createClaudeInteractionState,
  type ClaudeRunState,
  type ResidentClaudeSession,
} from '../backend/claudeInteractionState.ts';
import type { ClaudeInteractionContext } from '../backend/claudeInteractionContext.ts';
import { configureRuntimePaths, getRuntimePaths } from '../backend/runtimePaths.ts';
import { createClaudeRunState } from '../electron/claudeRunState.ts';
import { toClaudeProjectDirName } from '../electron/workspacePaths.ts';

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

run('resident runtime snapshots reconcile stale running tasks from native Claude history', () => {
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

  const previousUserProfile = process.env.USERPROFILE;
  const previousHomePath = getRuntimePaths().homePath;
  const tempHome = mkdtempSync(path.join(os.tmpdir(), 'resident-runtime-native-'));

  try {
    process.env.USERPROFILE = tempHome;
    configureRuntimePaths({ homePath: tempHome });

    const projectRoot = 'D:\\PBZ';
    const claudeSessionId = 'native-session';
    const nativeDir = path.join(
      tempHome,
      '.claude',
      'projects',
      toClaudeProjectDirName(projectRoot) ?? 'workspace',
    );
    mkdirSync(nativeDir, { recursive: true });
    writeFileSync(
      path.join(nativeDir, `${claudeSessionId}.jsonl`),
      `${JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        sessionId: claudeSessionId,
        content: `<task-notification>
<task-id>task-native</task-id>
<tool-use-id>tool-native</tool-use-id>
<status>completed</status>
<summary>Background command finished cleanly</summary>
</task-notification>`,
      })}\n`,
      'utf8',
    );

    const runState: ClaudeRunState = {
      ...createClaudeRunState(),
      claudeSessionId,
      backgroundTasks: new Map([
        [
          'task-native',
          {
            taskId: 'task-native',
            status: 'running',
            description: 'Background command task',
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
      projectRoot,
      currentTurn: undefined,
      activeOutputTurn: undefined,
      backgroundTaskOwners: new Map([
        [
          'task-native',
          {
            assistantMessageId: 'assistant-native',
            runState,
          },
        ],
      ]),
      queuedTurns: new Map(),
    } as unknown as ResidentClaudeSession;

    state.residentSessions.set('session-native', resident);
    syncResidentRuntimeState(ctx, state, 'session-native', resident);
    const snapshots = getSessionInteractionSnapshots(state);
    const residentSnapshot = snapshots['session-native'];

    assert.equal(events[0]?.runtime?.phase, 'idle');
    assert.equal(runState.backgroundTasks.get('task-native')?.status, 'completed');
    assert.equal(residentSnapshot?.runtime?.phase, 'idle');
    assert.equal(
      residentSnapshot?.backgroundTasks?.find((task) => task.taskId === 'task-native')?.status,
      'completed',
    );
  } finally {
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
    configureRuntimePaths({ homePath: previousHomePath });
    rmSync(tempHome, { recursive: true, force: true });
  }
});
