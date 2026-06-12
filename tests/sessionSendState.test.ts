import assert from 'node:assert/strict';
import {
  clearSessionSending,
  isSessionSending,
  markSessionSending,
} from '../src/data/sessionSendState.ts';

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

run('session send state only marks the targeted session as sending', () => {
  const sendingSessionIds = markSessionSending([], 'session-a');

  assert.equal(isSessionSending(sendingSessionIds, 'session-a'), true);
  assert.equal(isSessionSending(sendingSessionIds, 'session-b'), false);
});

run('session send state clears one session without affecting another active send', () => {
  const sendingSessionIds = markSessionSending(
    markSessionSending([], 'session-a'),
    'session-b',
  );

  const next = clearSessionSending(sendingSessionIds, 'session-a');

  assert.equal(isSessionSending(next, 'session-a'), false);
  assert.equal(isSessionSending(next, 'session-b'), true);
});
