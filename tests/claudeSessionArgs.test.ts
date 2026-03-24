import assert from 'node:assert/strict';
import { buildClaudeSessionArgs } from '../electron/claudeSessionArgs.js';

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

run('buildClaudeSessionArgs starts a new session when no claudeSessionId exists', () => {
  assert.deepEqual(buildClaudeSessionArgs(undefined, 'New Session 1'), ['-n', 'New Session 1']);
});

run('buildClaudeSessionArgs resumes the previous session when claudeSessionId exists', () => {
  assert.deepEqual(buildClaudeSessionArgs('abc-123', 'Ignored'), ['--resume', 'abc-123']);
});
