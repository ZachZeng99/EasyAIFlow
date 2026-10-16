import assert from 'node:assert/strict';
import {
  getKnownModelContextWindow,
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
  assert.equal(resolveRequestedModelArg('fable', 'implicit'), undefined);
});

run('resolveRequestedModelArg keeps model when selection is explicit', () => {
  assert.equal(resolveRequestedModelArg('sonnet', 'explicit'), 'sonnet');
});

run('syncImplicitModelSelection follows session model when selection is not explicit', () => {
  const result = syncImplicitModelSelection('opus[1m]', 'implicit', 'claude-sonnet-4-6');
  assert.deepEqual(result, { model: 'claude-sonnet-4-6', source: 'implicit' });
});

run('syncImplicitModelSelection preserves user choice when selection is explicit', () => {
  const result = syncImplicitModelSelection('sonnet', 'explicit', 'claude-opus-4-8');
  assert.deepEqual(result, { model: 'sonnet', source: 'explicit' });
});

run('normalizeModelSelectionValue preserves native model IDs for UI controls', () => {
  assert.equal(normalizeModelSelectionValue('claude-sonnet-4-6'), 'claude-sonnet-4-6');
  assert.equal(normalizeModelSelectionValue('claude-opus-4-8'), 'claude-opus-4-8');
  assert.equal(normalizeModelSelectionValue('claude'), 'fable');
  assert.equal(normalizeModelSelectionValue('claude-fable'), 'claude-fable');
});

run('getKnownModelContextWindow treats fable as a million-token Claude model', () => {
  assert.equal(getKnownModelContextWindow('fable'), 1000000);
  assert.equal(getKnownModelContextWindow('claude'), 1000000);
  assert.equal(getKnownModelContextWindow('claude-fable'), 1000000);
  assert.equal(getKnownModelContextWindow('opus[1m]'), 1000000);
  assert.equal(getKnownModelContextWindow('sonnet'), undefined);
});

run('normalizeModelSelectionValue ignores Claude synthetic placeholder models', () => {
  assert.equal(normalizeModelSelectionValue('<synthetic>'), undefined);
});

run('syncImplicitModelSelection keeps current model when session model is synthetic', () => {
  const result = syncImplicitModelSelection('fable', 'implicit', '<synthetic>');
  assert.deepEqual(result, { model: 'fable', source: 'implicit' });
});

run('shouldSwitchSessionModel requires a persisted Claude session and a real model change', () => {
  assert.equal(
    shouldSwitchSessionModel('opus[1m]', 'claude-sonnet-4-6', 'session-123', 'continue this task'),
    true,
  );
  assert.equal(
    shouldSwitchSessionModel('sonnet', 'claude-sonnet-4-6', 'session-123', 'continue this task'),
    true,
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
    syncModelSelectionForSession('sonnet', 'explicit', 'gpt-5.5', 'codex', ['gpt-5.5', 'gpt-5.5-mini']),
    {
      model: 'gpt-5.5',
      source: 'implicit',
    },
  );
  assert.deepEqual(
    syncModelSelectionForSession('gpt-5.5-mini', 'explicit', 'gpt-5.5', 'codex'),
    {
      model: 'gpt-5.5-mini',
      source: 'explicit',
    },
  );
});

run('syncModelSelectionForSession preserves new explicit models while the runtime catalog loads', () => {
  assert.deepEqual(
    syncModelSelectionForSession('gpt-future', 'explicit', 'gpt-5.5', 'codex'),
    {
      model: 'gpt-future',
      source: 'explicit',
    },
  );
});
