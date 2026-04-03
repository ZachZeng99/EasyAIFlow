import assert from 'node:assert/strict';
import {
  normalizeModelSelectionValue,
  resolveRequestedModelArg,
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
  const result = syncImplicitModelSelection('sonnet', 'explicit', 'claude-opus-4-6');
  assert.deepEqual(result, { model: 'sonnet', source: 'explicit' });
});

run('normalizeModelSelectionValue maps native model names back to 1m aliases for UI controls', () => {
  assert.equal(normalizeModelSelectionValue('claude-sonnet-4-6'), 'sonnet');
  assert.equal(normalizeModelSelectionValue('claude-opus-4-6'), 'opus[1m]');
});
