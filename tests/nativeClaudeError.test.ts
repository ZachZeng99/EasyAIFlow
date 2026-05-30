import assert from 'node:assert/strict';
import {
  extractLatestThinkingBlockMutationApiError,
  extractLatestSyntheticApiError,
  isClaudeThinkingBlockMutationApiError,
} from '../electron/nativeClaudeError.js';

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

run('extractLatestSyntheticApiError returns the latest synthetic API error text for a session', () => {
  const raw = [
    JSON.stringify({
      type: 'assistant',
      sessionId: 's1',
      isApiErrorMessage: true,
      message: { content: [{ type: 'text', text: 'API Error: 500 older' }] },
    }),
    JSON.stringify({
      type: 'assistant',
      sessionId: 's2',
      isApiErrorMessage: true,
      message: { content: [{ type: 'text', text: 'API Error: 500 other session' }] },
    }),
    JSON.stringify({
      type: 'assistant',
      sessionId: 's1',
      isApiErrorMessage: true,
      message: { content: [{ type: 'text', text: 'API Error: 500 latest' }] },
    }),
  ].join('\n');

  assert.equal(extractLatestSyntheticApiError(raw, 's1'), 'API Error: 500 latest');
});

run('extractLatestSyntheticApiError ignores normal assistant output', () => {
  const raw = JSON.stringify({
    type: 'assistant',
    sessionId: 's1',
    message: { content: [{ type: 'text', text: 'Hello' }] },
  });

  assert.equal(extractLatestSyntheticApiError(raw, 's1'), undefined);
});

run('isClaudeThinkingBlockMutationApiError detects unrecoverable thinking block resume errors', () => {
  assert.equal(
    isClaudeThinkingBlockMutationApiError(
      'API Error: 400 messages.121.content.14: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response.',
    ),
    true,
  );
  assert.equal(
    isClaudeThinkingBlockMutationApiError(
      'API Error: 500 No available Claude accounts support the requested model: <synthetic>.',
    ),
    false,
  );
});

run('extractLatestThinkingBlockMutationApiError scans past later non-matching synthetic errors', () => {
  const mutationError =
    'API Error: 400 messages.121.content.14: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified.';
  const raw = [
    JSON.stringify({
      type: 'assistant',
      sessionId: 's1',
      isApiErrorMessage: true,
      message: { content: [{ type: 'text', text: mutationError }] },
    }),
    JSON.stringify({
      type: 'assistant',
      sessionId: 's1',
      isApiErrorMessage: true,
      message: { content: [{ type: 'text', text: 'API Error: 500 transient' }] },
    }),
  ].join('\n');

  assert.equal(extractLatestThinkingBlockMutationApiError(raw, 's1'), mutationError);
});
