import assert from 'node:assert/strict';
import { resolveForkedNativeSessionId } from '../electron/nativeSessionFork.js';

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

run('resolveForkedNativeSessionId returns the newest new jsonl file', () => {
  const sessionId = resolveForkedNativeSessionId(
    new Set(['old-session']),
    [
      { name: 'old-session.jsonl', lastWriteTimeMs: 100 },
      { name: 'new-session-a.jsonl', lastWriteTimeMs: 200 },
      { name: 'new-session-b.jsonl', lastWriteTimeMs: 300 },
    ],
  );

  assert.equal(sessionId, 'new-session-b');
});

run('resolveForkedNativeSessionId ignores non-jsonl files and known ids', () => {
  const sessionId = resolveForkedNativeSessionId(
    new Set(['old-session', 'known-new']),
    [
      { name: 'old-session.jsonl', lastWriteTimeMs: 100 },
      { name: 'known-new.jsonl', lastWriteTimeMs: 300 },
      { name: 'temp-dir', lastWriteTimeMs: 400 },
    ],
  );

  assert.equal(sessionId, undefined);
});
