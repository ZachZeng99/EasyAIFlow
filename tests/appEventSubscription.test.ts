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
  assert.match(source, /}, \[playReplyCompleteTone\]\);/);
});
