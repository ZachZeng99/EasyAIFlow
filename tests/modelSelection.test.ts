import assert from 'node:assert/strict';
import {
  normalizeModelSelectionValue,
  resolveRequestedModelArg,
  shouldSwitchSessionModel,
  syncModelSelectionForSession,
  syncImplicitModelSelection,
} from '../src/data/modelSelection.js';

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

run('resolveRequestedModelArg omits model when selection is implicit', () => {
  assert.equal(resolveRequestedModelArg('opus[1m]', 'implicit'), undefined);
});

run('resolveRequestedModelArg keeps model when selection is explicit', () => {
  assert.equal(resolveRequestedModelArg('sonnet', 'explicit'), 'sonnet');
});

run('syncImplicitModelSelection follows session model when selection is not explicit', () => {
  const result = syncImplicitModelSelection('opus[1m]', 'implicit', 'claude-sonnet-4-6');
  assert.deepEqual(result, { model: 'sonnet', source: 'implicit' });
});

run('syncImplicitModelSelection preserves user choice when selection is explicit', () => {
  const result = syncImplicitModelSelection('sonnet', 'explicit', 'claude-opus-4-7');
  assert.deepEqual(result, { model: 'sonnet', source: 'explicit' });
});

run('normalizeModelSelectionValue maps native model names back to 1m aliases for UI controls', () => {
  assert.equal(normalizeModelSelectionValue('claude-sonnet-4-6'), 'sonnet');
  assert.equal(normalizeModelSelectionValue('claude-opus-4-7'), 'opus[1m]');
  assert.equal(normalizeModelSelectionValue('claude'), 'opus[1m]');
});

run('shouldSwitchSessionModel requires a persisted Claude session and a real model change', () => {
  assert.equal(
    shouldSwitchSessionModel('opus[1m]', 'claude-sonnet-4-6', 'session-123', 'continue this task'),
    true,
  );
  assert.equal(
    shouldSwitchSessionModel('sonnet', 'claude-sonnet-4-6', 'session-123', 'continue this task'),
    false,
  );
  assert.equal(
    shouldSwitchSessionModel('opus[1m]', 'claude-sonnet-4-6', undefined, 'continue this task'),
    false,
  );
  assert.equal(
    shouldSwitchSessionModel('opus[1m]', 'claude-sonnet-4-6', 'session-123', '/clear'),
    false,
  );
});

run('syncModelSelectionForSession resets explicit model choices that belong to another provider', () => {
  assert.deepEqual(
    syncModelSelectionForSession('sonnet', 'explicit', 'gpt-5.4', 'codex'),
    {
      model: 'gpt-5.4',
      source: 'implicit',
    },
  );
  assert.deepEqual(
    syncModelSelectionForSession('gpt-5.4-mini', 'explicit', 'gpt-5.4', 'codex'),
    {
      model: 'gpt-5.4-mini',
      source: 'explicit',
    },
  );
});
