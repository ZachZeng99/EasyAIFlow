import assert from 'node:assert/strict';
import { buildDisplayItems } from '../src/data/chatThreadDisplay.ts';
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

const messages: ConversationMessage[] = [
  {
    id: 'assistant-1',
    role: 'assistant',
    timestamp: '3/24 09:00',
    title: 'Reply',
    content: 'Implemented.',
  },
  {
    id: 'tool-edit-1',
    role: 'system',
    kind: 'tool_use',
    timestamp: '3/24 09:00',
    title: 'Edit',
    content:
      'X:\\AITool\\EasyAIFlow\\src\\components\\ChatThread.tsx\nThe file has been updated successfully.',
    status: 'success',
  },
];

run('buildDisplayItems attaches code change summaries to assistant messages', () => {
  const items = buildDisplayItems(messages);
  const messageItem = items.find((item) => item.type === 'message');

  assert.equal(messageItem?.type, 'message');
  assert.equal(messageItem?.codeChanges?.length, 1);
  assert.equal(
    messageItem?.codeChanges?.[0]?.filePath,
    'X:\\AITool\\EasyAIFlow\\src\\components\\ChatThread.tsx',
  );
});
