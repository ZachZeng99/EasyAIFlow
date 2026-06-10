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

run('getDefaultModelForProvider uses fable for Claude sessions', () => {
  assert.equal(getDefaultModelForProvider('claude'), 'fable');
});

run('getDefaultModelForProvider keeps the Codex default model', () => {
  assert.equal(getDefaultModelForProvider('codex'), 'gpt-5.5');
});
