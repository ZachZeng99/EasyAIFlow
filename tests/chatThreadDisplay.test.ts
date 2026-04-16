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
  assert.equal(items[0]?.type, 'trace-group');
  assert.equal(items[1]?.type, 'message');
  assert.equal(
    messageItem?.codeChanges?.[0]?.filePath,
    'X:\\AITool\\EasyAIFlow\\src\\components\\ChatThread.tsx',
  );
});

run('buildDisplayItems places later trace items before the assistant reply without replacing it', () => {
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
    ['user-1', 'trace-group-assistant-2', 'assistant-2'],
  );
  const assistantItem = items.find((item) => item.type === 'message' && item.message.id === 'assistant-2');
  assert.equal(assistantItem?.type, 'message');
  assert.equal(assistantItem?.message.content, 'Compiling now.');
});

run('buildDisplayItems keeps per-speaker trace groups separate in group chats', () => {
  const grouped = buildDisplayItems([
    {
      id: 'assistant-claude',
      role: 'assistant',
      timestamp: '3/24 09:01',
      title: 'Claude response',
      content: 'I reviewed the plan.',
      speakerId: 'claude',
      speakerLabel: 'Claude',
      provider: 'claude',
    },
    {
      id: 'assistant-codex',
      role: 'assistant',
      timestamp: '3/24 09:01',
      title: 'Codex response',
      content: 'I checked the implementation.',
      speakerId: 'codex',
      speakerLabel: 'Codex',
      provider: 'codex',
    },
    {
      id: 'trace-claude',
      role: 'system',
      kind: 'tool_use',
      timestamp: '3/24 09:01',
      title: 'Read',
      content: 'Read app.tsx',
      speakerId: 'claude',
      speakerLabel: 'Claude',
      provider: 'claude',
      status: 'success',
    },
    {
      id: 'trace-codex',
      role: 'system',
      kind: 'tool_use',
      timestamp: '3/24 09:01',
      title: 'Run',
      content: 'npm run check',
      speakerId: 'codex',
      speakerLabel: 'Codex',
      provider: 'codex',
      status: 'success',
    },
  ]);

  const traceGroups = grouped.filter((item) => item.type === 'trace-group');
  assert.equal(traceGroups.length, 2);
  assert.deepEqual(
    traceGroups.map((item) => item.items[0]?.speakerId),
    ['claude', 'codex'],
  );
});

run('buildDisplayItems reattaches late interleaved trace items to the matching group reply', () => {
  const grouped = buildDisplayItems([
    {
      id: 'user-1',
      role: 'user',
      timestamp: '4/13 14:49',
      title: '@all',
      content: '@all look into this timeout.',
      speakerId: 'user',
      speakerLabel: 'You',
      status: 'complete',
    },
    {
      id: 'assistant-claude',
      role: 'assistant',
      timestamp: '4/13 14:50',
      title: 'Claude response',
      content: 'I finished first.',
      speakerId: 'claude',
      speakerLabel: 'Claude',
      provider: 'claude',
      status: 'complete',
    },
    {
      id: 'assistant-codex',
      role: 'assistant',
      timestamp: '4/13 14:55',
      title: 'Codex error',
      content: 'Codex turn timed out.',
      speakerId: 'codex',
      speakerLabel: 'Codex',
      provider: 'codex',
      status: 'error',
    },
    {
      id: 'trace-codex-1',
      role: 'system',
      kind: 'tool_use',
      timestamp: '4/13 14:51',
      title: 'Command',
      content: 'rg -n "timeout"',
      speakerId: 'codex',
      speakerLabel: 'Codex',
      provider: 'codex',
      status: 'success',
    },
    {
      id: 'trace-claude-1',
      role: 'system',
      kind: 'tool_use',
      timestamp: '4/13 14:51',
      title: 'Bash',
      content: 'git show',
      speakerId: 'claude',
      speakerLabel: 'Claude',
      provider: 'claude',
      status: 'success',
    },
    {
      id: 'trace-codex-2',
      role: 'system',
      kind: 'tool_use',
      timestamp: '4/13 14:54',
      title: 'Command',
      content: 'Get-Content log.txt',
      speakerId: 'codex',
      speakerLabel: 'Codex',
      provider: 'codex',
      status: 'error',
    },
  ]);

  assert.deepEqual(
    grouped.map((item) => (item.type === 'message' ? item.message.id : item.id)),
    ['user-1', 'trace-group-assistant-claude', 'assistant-claude', 'trace-group-assistant-codex', 'assistant-codex'],
  );

  const claudeReply = grouped.find(
    (item) => item.type === 'message' && item.message.id === 'assistant-claude',
  );
  assert.equal(claudeReply?.type, 'message');
  assert.deepEqual(
    claudeReply?.relatedTraceItems?.map((message) => message.id),
    ['trace-claude-1'],
  );

  const codexReply = grouped.find(
    (item) => item.type === 'message' && item.message.id === 'assistant-codex',
  );
  assert.equal(codexReply?.type, 'message');
  assert.deepEqual(
    codexReply?.relatedTraceItems?.map((message) => message.id),
    ['trace-codex-1', 'trace-codex-2'],
  );
});
