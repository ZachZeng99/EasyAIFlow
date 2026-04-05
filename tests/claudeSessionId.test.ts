import assert from 'node:assert/strict';
import { applyParsedSessionMetadata, extractClaudeSessionId } from '../electron/claudeSessionId.js';

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

run('applyParsedSessionMetadata captures session ids from control requests before the run exits early', () => {
  const updated = applyParsedSessionMetadata(
    {},
    {
      type: 'control_request',
      session_id: 'control-session-id',
      request: {
        subtype: 'can_use_tool',
      },
    },
  );

  assert.deepEqual(updated, {
    claudeSessionId: 'control-session-id',
  });
});

run('applyParsedSessionMetadata keeps the latest assistant model metadata', () => {
  const updated = applyParsedSessionMetadata(
    {
      claudeSessionId: 'existing-session',
    },
    {
      type: 'assistant',
      message: {
        model: 'claude-opus-4-6',
      },
    },
  );

  assert.deepEqual(updated, {
    claudeSessionId: 'existing-session',
    model: 'claude-opus-4-6',
  });
});

run('applyParsedSessionMetadata captures the init model before the first assistant turn', () => {
  const updated = applyParsedSessionMetadata(
    {
      claudeSessionId: 'existing-session',
    },
    {
      type: 'system',
      subtype: 'init',
      model: 'claude-opus-4-6[1m]',
    },
  );

  assert.deepEqual(updated, {
    claudeSessionId: 'existing-session',
    model: 'claude-opus-4-6[1m]',
  });
});
