import assert from 'node:assert/strict';
import {
  mergeSessionRuntimeStates,
  setSessionRuntimeState,
} from '../src/data/sessionInteraction.ts';
import type { SessionRuntimeState } from '../src/data/types.ts';

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

const makeRuntime = (overrides: Partial<SessionRuntimeState> = {}): SessionRuntimeState => ({
  processActive: false,
  phase: 'inactive',
  updatedAt: 1,
  ...overrides,
});

run('mergeSessionRuntimeStates prefers online idle over offline inactive', () => {
  const merged = mergeSessionRuntimeStates([
    makeRuntime({ processActive: false, phase: 'inactive', updatedAt: 10 }),
    makeRuntime({ processActive: true, phase: 'idle', updatedAt: 5 }),
  ]);

  assert.deepEqual(merged, {
    processActive: true,
    phase: 'idle',
    updatedAt: 10,
  });
});

run('mergeSessionRuntimeStates prefers an active running phase over idle', () => {
  const merged = mergeSessionRuntimeStates([
    makeRuntime({ processActive: true, phase: 'idle', updatedAt: 10 }),
    makeRuntime({ processActive: true, phase: 'running', updatedAt: 5 }),
  ]);

  assert.deepEqual(merged, {
    processActive: true,
    phase: 'running',
    updatedAt: 10,
  });
});

run('mergeSessionRuntimeStates falls back to the latest offline state when nothing is online', () => {
  const merged = mergeSessionRuntimeStates([
    makeRuntime({ processActive: false, phase: 'inactive', updatedAt: 10 }),
    makeRuntime({ processActive: false, phase: 'inactive', updatedAt: 25 }),
  ]);

  assert.deepEqual(merged, {
    processActive: false,
    phase: 'inactive',
    updatedAt: 25,
  });
});

run('setSessionRuntimeState prunes stale active background tasks when the runtime is no longer background', () => {
  const next = setSessionRuntimeState(
    {
      backgroundTasks: [
        {
          taskId: 'task-running',
          status: 'running',
          description: 'Still marked active locally',
          updatedAt: 10,
        },
        {
          taskId: 'task-done',
          status: 'completed',
          description: 'Already finished',
          updatedAt: 9,
        },
      ],
    },
    makeRuntime({ processActive: true, phase: 'idle', updatedAt: 20 }),
  );

  assert.deepEqual(next.backgroundTasks, [
    {
      taskId: 'task-done',
      status: 'completed',
      description: 'Already finished',
      updatedAt: 9,
    },
  ]);
  assert.equal(next.runtime?.phase, 'idle');
});

run('setSessionRuntimeState preserves active background tasks while the runtime remains background', () => {
  const next = setSessionRuntimeState(
    {
      backgroundTasks: [
        {
          taskId: 'task-running',
          status: 'running',
          description: 'Background command task',
          updatedAt: 10,
        },
      ],
    },
    makeRuntime({ processActive: true, phase: 'background', updatedAt: 20 }),
  );

  assert.deepEqual(next.backgroundTasks, [
    {
      taskId: 'task-running',
      status: 'running',
      description: 'Background command task',
      updatedAt: 10,
    },
  ]);
  assert.equal(next.runtime?.phase, 'background');
});
