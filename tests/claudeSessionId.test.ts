import assert from 'node:assert/strict';
import { extractClaudeSessionId } from '../electron/claudeSessionId.js';

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

run('extractClaudeSessionId reads snake_case session ids', () => {
  assert.equal(extractClaudeSessionId({ session_id: 'snake-case-id' }), 'snake-case-id');
});

run('extractClaudeSessionId reads camelCase session ids', () => {
  assert.equal(extractClaudeSessionId({ sessionId: 'camel-case-id' }), 'camel-case-id');
});

run('extractClaudeSessionId ignores missing or blank values', () => {
  assert.equal(extractClaudeSessionId({ sessionId: '   ' }), undefined);
  assert.equal(extractClaudeSessionId({}), undefined);
});
