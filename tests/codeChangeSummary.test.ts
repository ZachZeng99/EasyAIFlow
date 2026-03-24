import assert from 'node:assert/strict';
import { extractCodeChangeSummaries } from '../src/data/codeChangeSummary.ts';
import type { ConversationMessage } from '../src/data/types.ts';

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

const makeTrace = (overrides: Partial<ConversationMessage>): ConversationMessage => ({
  id: overrides.id ?? 'trace-1',
  role: overrides.role ?? 'system',
  kind: overrides.kind ?? 'tool_use',
  timestamp: overrides.timestamp ?? 'now',
  title: overrides.title ?? 'Edit',
  content: overrides.content ?? 'X:\\AITool\\EasyAIFlow\\src\\components\\ChatThread.tsx\nThe file has been updated successfully.',
  status: overrides.status ?? 'success',
});

run('extractCodeChangeSummaries keeps file updates and derives a summary', () => {
  const summaries = extractCodeChangeSummaries([
    makeTrace({
      title: 'Edit',
      content:
        'X:\\AITool\\EasyAIFlow\\src\\components\\ChatThread.tsx\nThe file has been updated successfully.',
    }),
  ]);

  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]?.filePath, 'X:\\AITool\\EasyAIFlow\\src\\components\\ChatThread.tsx');
  assert.equal(summaries[0]?.operationLabel, 'Edited');
  assert.equal(summaries[0]?.summary, 'Edited ChatThread.tsx');
});

run('extractCodeChangeSummaries keeps meaningful detail lines when present', () => {
  const summaries = extractCodeChangeSummaries([
    makeTrace({
      title: 'Edit',
      content: [
        'X:\\AITool\\EasyAIFlow\\src\\components\\ChatThread.tsx',
        'Adjusted diff card layout to keep long paths readable.',
        'The file has been updated successfully.',
      ].join('\n'),
    }),
  ]);

  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]?.summary, 'Adjusted diff card layout to keep long paths readable.');
});

run('extractCodeChangeSummaries ignores non-edit tool traces', () => {
  const summaries = extractCodeChangeSummaries([
    makeTrace({
      title: 'Read',
      content: 'X:\\AITool\\EasyAIFlow\\src\\components\\ChatThread.tsx',
    }),
  ]);

  assert.equal(summaries.length, 0);
});
