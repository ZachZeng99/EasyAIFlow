import assert from 'node:assert/strict';
import { extractLatestSyntheticApiError } from '../electron/nativeClaudeError.js';

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
