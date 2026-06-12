import assert from 'node:assert/strict';
import {
  restoreSessionDraftIfUnchanged,
  setSessionDraftValue,
} from '../src/data/sessionDrafts.ts';

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

run('setSessionDraftValue clears the submitted session draft without touching other sessions', () => {
  const next = setSessionDraftValue(
    {
      'session-a': 'send this',
      'session-b': 'keep this',
    },
    'session-a',
    '',
  );

  assert.deepEqual(next, {
    'session-b': 'keep this',
  });
});

run('restoreSessionDraftIfUnchanged restores a failed send only while the draft is still empty', () => {
  const restored = restoreSessionDraftIfUnchanged({}, 'session-a', '', 'send this');
  const preserved = restoreSessionDraftIfUnchanged(
    {
      'session-a': 'new draft',
    },
    'session-a',
    '',
    'send this',
  );

  assert.deepEqual(restored, {
    'session-a': 'send this',
  });
  assert.deepEqual(preserved, {
    'session-a': 'new draft',
  });
});
