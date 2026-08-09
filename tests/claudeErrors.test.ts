import assert from 'node:assert/strict';
import { getClaudeResultError, getClaudeSyntheticApiError } from '../electron/claudeErrors.js';

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

run('getClaudeSyntheticApiError extracts SDK synthetic API error messages', () => {
  const error = getClaudeSyntheticApiError({
    type: 'assistant',
    isApiErrorMessage: true,
    message: {
      model: '<synthetic>',
      content: [{ type: 'text', text: 'API Error: 500 No available Claude accounts support the requested model: claude-opus-4-6' }],
    },
  });

  assert.equal(error, 'API Error: 500 No available Claude accounts support the requested model: claude-opus-4-6');
});

run('getClaudeSyntheticApiError ignores normal assistant messages', () => {
  const error = getClaudeSyntheticApiError({
    type: 'assistant',
    message: {
      model: 'claude-opus-4-6',
      content: [{ type: 'text', text: 'Hello' }],
    },
  });

  assert.equal(error, undefined);
});

run('getClaudeResultError extracts stream-json result errors', () => {
  assert.equal(
    getClaudeResultError({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['Upstream request ended before Claude returned a final response.'],
    }),
    'Upstream request ended before Claude returned a final response.',
  );
});

run('getClaudeResultError ignores successful results', () => {
  assert.equal(
    getClaudeResultError({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Done.',
    }),
    undefined,
  );
});
