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

run('buildClaudeSessionArgs pins first native Claude run to the EAF session id', () => {
  assert.deepEqual(
    buildClaudeSessionArgs(undefined, 'New Session 1', false, '5d2d59a8-8eb0-4fc0-8c1b-c06e7b49de1f'),
    ['-n', 'New Session 1', '--session-id', '5d2d59a8-8eb0-4fc0-8c1b-c06e7b49de1f'],
  );
});

run('buildClaudeSessionArgs resumes the previous session when claudeSessionId exists', () => {
  assert.deepEqual(buildClaudeSessionArgs('abc-123', 'Ignored'), ['--resume', 'abc-123']);
});
