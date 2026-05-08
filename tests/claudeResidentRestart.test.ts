import assert from 'node:assert/strict';
import { isWritableStdin } from '../backend/claudeHelpers.ts';

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

run('isWritableStdin rejects an exited child even when the stream flags still look open', () => {
  assert.equal(
    isWritableStdin({
      killed: false,
      exitCode: 0,
      signalCode: null,
      stdin: {
        destroyed: false,
        writable: true,
        writableEnded: false,
      },
    }),
    false,
  );
});

run('isWritableStdin rejects a child whose stdin is no longer writable', () => {
  assert.equal(
    isWritableStdin({
      killed: false,
      exitCode: null,
      signalCode: null,
      stdin: {
        destroyed: false,
        writable: false,
        writableEnded: false,
      },
    }),
    false,
  );
});
