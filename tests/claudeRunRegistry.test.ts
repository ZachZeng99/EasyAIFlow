import assert from 'node:assert/strict';
import {
  addActiveClaudeRun,
  createActiveClaudeRunRegistry,
  listActiveClaudeRunsForSession,
  removeActiveClaudeRun,
} from '../electron/claudeRunRegistry.ts';

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

run('run registry keeps multiple active runs for the same session', () => {
  const registry = createActiveClaudeRunRegistry<{ label: string }>();

  addActiveClaudeRun(registry, {
    runId: 'run-1',
    sessionId: 'session-1',
    child: { label: 'first' },
    projectRoot: 'X:/one',
  });
  addActiveClaudeRun(registry, {
    runId: 'run-2',
    sessionId: 'session-1',
    child: { label: 'second' },
    projectRoot: 'X:/one',
  });

  assert.deepEqual(
    listActiveClaudeRunsForSession(registry, 'session-1').map((entry) => entry.runId),
    ['run-1', 'run-2'],
  );

  removeActiveClaudeRun(registry, 'run-1');

  assert.deepEqual(
    listActiveClaudeRunsForSession(registry, 'session-1').map((entry) => entry.runId),
    ['run-2'],
  );
});

run('run registry isolates runs by session', () => {
  const registry = createActiveClaudeRunRegistry<{ label: string }>();

  addActiveClaudeRun(registry, {
    runId: 'run-1',
    sessionId: 'session-1',
    child: { label: 'first' },
    projectRoot: 'X:/one',
  });
  addActiveClaudeRun(registry, {
    runId: 'run-2',
    sessionId: 'session-2',
    child: { label: 'second' },
    projectRoot: 'X:/two',
  });

  assert.deepEqual(
    listActiveClaudeRunsForSession(registry, 'session-2').map((entry) => entry.runId),
    ['run-2'],
  );
});
