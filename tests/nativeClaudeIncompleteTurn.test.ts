import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseNativeClaudeSessionFile } from '../electron/sessionStore.ts';

const run = async (name: string, fn: () => Promise<void>) => {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

const writeNativeSession = async (records: unknown[]) => {
  const tempBase = path.resolve('.tmp-tests');
  await mkdir(tempBase, { recursive: true });
  const tempRoot = await mkdtemp(path.join(tempBase, 'native-claude-incomplete-'));
  const filePath = path.join(tempRoot, 'session.jsonl');
  await writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
  return filePath;
};

const userPrompt = {
  type: 'user',
  timestamp: '2026-08-05T04:12:52.784Z',
  cwd: 'X:\\PBZ\\ProjectPBZ',
  sessionId: 'session',
  message: {
    role: 'user',
    content: 'Why does the new probe darken nearby GI?',
  },
};

const partialAssistant = {
  type: 'assistant',
  timestamp: '2026-08-05T04:13:58.929Z',
  message: {
    role: 'assistant',
    stop_reason: 'tool_use',
    content: [
      {
        type: 'text',
        text: 'This points to the problem. Let me verify the darkening mechanism.',
      },
      {
        type: 'tool_use',
        id: 'tool-1',
        name: 'Bash',
        input: { command: 'inspect shader' },
      },
    ],
  },
};

const toolResult = {
  type: 'user',
  timestamp: '2026-08-05T04:14:06.354Z',
  message: {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'tool-1',
        content: 'shader source',
      },
    ],
  },
};

await run('native Claude recovery marks a tool-use turn without end_turn as incomplete', async () => {
  const filePath = await writeNativeSession([userPrompt, partialAssistant, toolResult]);
  const parsed = await parseNativeClaudeSessionFile(filePath);
  assert.ok(parsed);

  const assistant = parsed.messages.find((message) => message.role === 'assistant');
  assert.equal(assistant?.status, 'error');
  assert.equal(assistant?.title, 'Claude incomplete response');
  assert.match(assistant?.content ?? '', /Let me verify the darkening mechanism/);
  assert.match(assistant?.content ?? '', /without returning a final response/);
});

await run('native Claude recovery keeps a final end_turn response complete', async () => {
  const finalAssistant = {
    type: 'assistant',
    timestamp: '2026-08-05T04:14:20.000Z',
    message: {
      role: 'assistant',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'The final weighted interpolation explanation.' }],
    },
  };
  const filePath = await writeNativeSession([
    userPrompt,
    partialAssistant,
    toolResult,
    finalAssistant,
  ]);
  const parsed = await parseNativeClaudeSessionFile(filePath);
  assert.ok(parsed);

  const assistantMessages = parsed.messages.filter((message) => message.role === 'assistant');
  assert.equal(assistantMessages[0]?.status, 'complete');
  assert.equal(assistantMessages[0]?.content.includes('without returning a final response'), false);
  assert.equal(assistantMessages[1]?.status, 'complete');
  assert.equal(assistantMessages[1]?.content, 'The final weighted interpolation explanation.');
});

await run('native Claude recovery does not fail a pending interactive question', async () => {
  const pendingQuestion = {
    type: 'assistant',
    timestamp: '2026-08-05T04:14:20.000Z',
    message: {
      role: 'assistant',
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'I need one choice before continuing.' },
        {
          type: 'tool_use',
          id: 'question-1',
          name: 'AskUserQuestion',
          input: {
            questions: [
              {
                header: 'Approach',
                question: 'Which approach should I use?',
                multiSelect: false,
                options: [
                  { label: 'Focused', description: 'Apply the narrow fix.' },
                  { label: 'Broad', description: 'Refactor the whole path.' },
                ],
              },
            ],
          },
        },
      ],
    },
  };
  const filePath = await writeNativeSession([userPrompt, pendingQuestion]);
  const parsed = await parseNativeClaudeSessionFile(filePath);
  assert.ok(parsed);

  const assistantMessages = parsed.messages.filter((message) => message.role === 'assistant');
  assert.ok(assistantMessages.length > 0);
  assert.equal(assistantMessages.some((message) => message.status === 'error'), false);
  assert.equal(
    assistantMessages.some((message) =>
      message.content.includes('without returning a final response'),
    ),
    false,
  );
});

await run('native Claude recovery keeps an active background launch pending', async () => {
  const backgroundToolResult = {
    ...toolResult,
    toolUseResult: {
      backgroundTaskId: 'task-1',
      status: 'running',
      description: 'Inspect shader in background',
    },
  };
  const filePath = await writeNativeSession([
    userPrompt,
    partialAssistant,
    backgroundToolResult,
  ]);
  const parsed = await parseNativeClaudeSessionFile(filePath);
  assert.ok(parsed);

  const assistant = parsed.messages.find((message) => message.role === 'assistant');
  assert.equal(assistant?.status, 'complete');
  assert.equal(assistant?.content.includes('without returning a final response'), false);
});

await run('native Claude recovery preserves a missing reply before the next user prompt', async () => {
  const nextUserPrompt = {
    ...userPrompt,
    timestamp: '2026-08-05T04:20:00.000Z',
    message: {
      role: 'user',
      content: 'A follow-up that proves the prior turn already ended.',
    },
  };
  const filePath = await writeNativeSession([userPrompt, nextUserPrompt]);
  const parsed = await parseNativeClaudeSessionFile(filePath);
  assert.ok(parsed);

  assert.deepEqual(
    parsed.messages.map((message) => [message.role, message.status]),
    [
      ['user', 'complete'],
      ['assistant', 'error'],
      ['user', 'complete'],
    ],
  );
  assert.equal(
    parsed.messages[1]?.content,
    'Claude finished without returning a visible response.',
  );
});

await run('native Claude recovery leaves a final user prompt open at EOF', async () => {
  const filePath = await writeNativeSession([userPrompt]);
  const parsed = await parseNativeClaudeSessionFile(filePath);
  assert.ok(parsed);

  assert.deepEqual(
    parsed.messages.map((message) => [message.role, message.status]),
    [['user', 'complete']],
  );
});

await run('native Claude recovery finalizes an abandoned EOF prompt when requested', async () => {
  const filePath = await writeNativeSession([userPrompt]);
  const parsed = await parseNativeClaudeSessionFile(filePath, {
    finalizeTrailingUserTurn: true,
  });
  assert.ok(parsed);

  assert.deepEqual(
    parsed.messages.map((message) => [message.role, message.status]),
    [
      ['user', 'complete'],
      ['assistant', 'error'],
    ],
  );
  assert.equal(
    parsed.messages[1]?.content,
    'Claude finished without returning a visible response.',
  );
});

await run('native Claude recovery accepts a silent end_turn before the next prompt', async () => {
  const silentEndTurn = {
    type: 'assistant',
    timestamp: '2026-08-05T04:13:00.000Z',
    message: {
      role: 'assistant',
      stop_reason: 'end_turn',
      content: [],
    },
  };
  const nextUserPrompt = {
    ...userPrompt,
    timestamp: '2026-08-05T04:20:00.000Z',
    message: { role: 'user', content: 'Continue.' },
  };
  const filePath = await writeNativeSession([userPrompt, silentEndTurn, nextUserPrompt]);
  const parsed = await parseNativeClaudeSessionFile(filePath);
  assert.ok(parsed);

  assert.equal(parsed.messages.some((message) => message.status === 'error'), false);
});

await run('native Claude recovery restores queued steering commands as user messages', async () => {
  const queuedCommand = {
    type: 'attachment',
    timestamp: '2026-08-05T04:15:00.000Z',
    attachment: {
      type: 'queued_command',
      prompt: '你现在再干嘛？',
      source_uuid: 'local-user-message-id',
    },
  };
  const responseAfterSteer = {
    type: 'assistant',
    timestamp: '2026-08-05T04:15:10.000Z',
    message: {
      role: 'assistant',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'I am finishing the APT comparison.' }],
    },
  };
  const filePath = await writeNativeSession([
    userPrompt,
    partialAssistant,
    toolResult,
    {
      type: 'queue-operation',
      operation: 'enqueue',
      timestamp: '2026-08-05T04:15:00.000Z',
      content: '你现在再干嘛？',
    },
    queuedCommand,
    responseAfterSteer,
  ]);
  const parsed = await parseNativeClaudeSessionFile(filePath);
  assert.ok(parsed);

  const restored = parsed.messages.find((message) => message.id === 'local-user-message-id');
  assert.equal(restored?.role, 'user');
  assert.equal(restored?.content, '你现在再干嘛？');
  assert.equal(
    parsed.messages.filter((message) => message.role === 'user' && message.content === '你现在再干嘛？').length,
    1,
  );
  assert.equal(parsed.messages.at(-1)?.content, 'I am finishing the APT comparison.');
});
