import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

run('Claude event subscription does not reconnect when selected session changes', () => {
  const source = readFileSync('src/App.tsx', 'utf8');

  assert.doesNotMatch(source, /}, \[activeSelectedSessionId,\s*playReplyCompleteTone\]\);/);
  assert.match(source, /}, \[playReplyCompleteTone, resyncActiveSessionFromBridge\]\);/);
});

run('native sessions poll for appended history and SSE reconnects resync the selected record', () => {
  const source = readFileSync('src/App.tsx', 'utf8');

  assert.match(source, /NATIVE_SESSION_REFRESH_INTERVAL_MS = 2_000/);
  assert.match(source, /setInterval\(refreshSelectedNativeSession, NATIVE_SESSION_REFRESH_INTERVAL_MS\)/);
  assert.match(source, /bridge\.getSessionHistoryRevision/);
  assert.match(source, /event\.type === 'interaction-sync'[\s\S]{0,240}resyncActiveSessionFromBridge\(\)/);
});
