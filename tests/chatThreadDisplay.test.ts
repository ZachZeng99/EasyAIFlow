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
  assert.equal(items[0]?.type, 'message');
  assert.equal(items[1]?.type, 'trace-group');
  assert.equal(
    messageItem?.codeChanges?.[0]?.filePath,
    'X:\\AITool\\EasyAIFlow\\src\\components\\ChatThread.tsx',
  );
});

run('buildDisplayItems keeps the assistant reply in place when later trace items arrive', () => {
  const items = buildDisplayItems([
    {
      id: 'user-1',
      role: 'user',
      timestamp: '4/11 00:35',
      title: 'User',
      content: 'Build it.',
    },
    {
      id: 'assistant-2',
      role: 'assistant',
      timestamp: '4/11 00:35',
      title: 'Claude response',
      content: 'Compiling now.',
      status: 'streaming',
    },
    {
      id: 'tool-2',
      role: 'system',
      kind: 'tool_use',
      timestamp: '4/11 00:35',
      title: 'Bash',
      content: 'npm run build',
      status: 'running',
    },
  ]);

  assert.deepEqual(
    items.map((item) => (item.type === 'message' ? item.message.id : item.id)),
    ['user-1', 'assistant-2', 'trace-group-assistant-2'],
  );
});
