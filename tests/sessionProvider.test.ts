import assert from 'node:assert/strict';
import { getDefaultModelForProvider } from '../src/data/sessionProvider.js';

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

run('getDefaultModelForProvider keeps the current Claude default', () => {
  assert.equal(getDefaultModelForProvider('claude'), 'opus[1m]');
});

run('getDefaultModelForProvider uses GPT-5.6 Sol for new Codex sessions', () => {
  assert.equal(getDefaultModelForProvider('codex'), 'gpt-5.6-sol');
});
