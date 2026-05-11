import assert from 'node:assert/strict';
import {
  extractMissingClaudeConversationSessionId,
  formatClaudeProcessUnavailableMessage,
  isLiveChildProcess,
  isWritableStdin,
} from '../backend/claudeHelpers.ts';

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

run('isWritableStdin rejects exited Claude child processes', () => {
  assert.equal(
    isWritableStdin({
      killed: false,
      exitCode: 1,
      signalCode: null,
      stdin: {
        destroyed: false,
        writableEnded: false,
        writable: true,
      },
    }),
    false,
  );
});

run('isLiveChildProcess requires a child that has not exited or signaled', () => {
  assert.equal(isLiveChildProcess({ killed: false, exitCode: null, signalCode: null }), true);
  assert.equal(isLiveChildProcess({ killed: false, exitCode: 0, signalCode: null }), false);
  assert.equal(isLiveChildProcess({ killed: false, exitCode: null, signalCode: 'SIGTERM' }), false);
});

run('formatClaudeProcessUnavailableMessage prefers stderr over generic stdin text', () => {
  assert.equal(
    formatClaudeProcessUnavailableMessage({
      stderr: 'Unknown option: --bad-flag',
      exitCode: 1,
    }),
    'Unknown option: --bad-flag',
  );
});

run('formatClaudeProcessUnavailableMessage falls back to the Claude exit code', () => {
  assert.equal(
    formatClaudeProcessUnavailableMessage({
      exitCode: 1,
    }),
    'Claude exited before it was ready (code 1).',
  );
});

run('extractMissingClaudeConversationSessionId reads Claude stream-json resume failures', () => {
  assert.equal(
    extractMissingClaudeConversationSessionId({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['No conversation found with session ID: b1d5f1cb-25b4-4636-b1fe-fc090bc2c947'],
    }),
    'b1d5f1cb-25b4-4636-b1fe-fc090bc2c947',
  );
});
