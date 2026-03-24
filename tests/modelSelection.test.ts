import assert from 'node:assert/strict';
import { resolveRequestedModelArg, syncImplicitModelSelection } from '../src/data/modelSelection.js';

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
  assert.equal(resolveRequestedModelArg('sonnet[1m]', 'explicit'), 'sonnet[1m]');
});

run('syncImplicitModelSelection follows session model when selection is not explicit', () => {
  const result = syncImplicitModelSelection('opus[1m]', 'implicit', 'claude-sonnet-4-6');
  assert.deepEqual(result, { model: 'sonnet[1m]', source: 'implicit' });
});

run('syncImplicitModelSelection preserves user choice when selection is explicit', () => {
  const result = syncImplicitModelSelection('sonnet[1m]', 'explicit', 'claude-opus-4-6');
  assert.deepEqual(result, { model: 'sonnet[1m]', source: 'explicit' });
});
