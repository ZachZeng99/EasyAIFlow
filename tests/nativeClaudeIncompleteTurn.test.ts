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

await run('native Claude recovery keeps an active trailing tool loop open', async () => {
  const deployingAssistant = {
    type: 'assistant',
    timestamp: '2026-08-05T04:14:20.000Z',
    message: {
      role: 'assistant',
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'Deploying and relaunching.' },
        {
          type: 'tool_use',
          id: 'tool-2',
          name: 'Bash',
          input: { command: 'deploy && sleep 235 && verify' },
        },
      ],
    },
  };
  const filePath = await writeNativeSession([
    userPrompt,
    partialAssistant,
    toolResult,
    deployingAssistant,
  ]);
  const parsed = await parseNativeClaudeSessionFile(filePath, {
    finalizeTrailingToolTurn: false,
  });
  assert.ok(parsed);

  const assistantMessages = parsed.messages.filter((message) => message.role === 'assistant');
  assert.equal(assistantMessages.some((message) => message.status === 'error'), false);
  assert.equal(
    assistantMessages.some((message) =>
      message.content.includes('without returning a final response'),
    ),
    false,
  );
  assert.equal(parsed.messages.find((message) => message.id === 'tool-2')?.status, 'running');
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

const retryEvent = {
  type: 'system', subtype: 'api_error', source: 'request_retry',
  timestamp: '2026-08-05T04:14:10.000Z',
  retryAttempt: 1, maxRetries: 10, error: { message: 'Connection error.' },
};

await run('transient retries do not permanently fail a turn that later succeeds', async () => {
  const success = { type: 'assistant', timestamp: '2026-08-05T04:14:20.000Z', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Verified successfully.' }] } };
  for (const tail of [[retryEvent, success], [success, retryEvent]]) {
    const parsed = await parseNativeClaudeSessionFile(await writeNativeSession([userPrompt, partialAssistant, toolResult, ...tail]));
    assert.ok(parsed);
    assert.equal(parsed.messages.some(m => m.status === 'error'), false);
    assert.equal(parsed.messages.at(-1)?.content, 'Verified successfully.');
  }
});

await run('active retries remain pending but abandoned retries retain their real failure', async () => {
  const records = [userPrompt, partialAssistant, toolResult, retryEvent];
  const file = await writeNativeSession(records);
  const active = await parseNativeClaudeSessionFile(file, { finalizeTrailingUserTurn: false, finalizeTrailingToolTurn: false });
  assert.equal(active?.messages.some(m => m.status === 'error'), false);
  const stopped = await parseNativeClaudeSessionFile(file, { finalizeTrailingUserTurn: true, finalizeTrailingToolTurn: true });
  assert.ok(stopped?.messages.some(m => m.status === 'error' && m.content.includes('Connection error.')));
  const followup = { ...userPrompt, timestamp: '2026-08-05T04:15:00Z', message: { role: 'user', content: 'Try again.' } };
  const nextTurn = await parseNativeClaudeSessionFile(await writeNativeSession([...records, followup]));
  assert.ok(nextTurn?.messages.some(m => m.status === 'error' && m.content.includes('Connection error.')));
});

await run('a synthetic no-response acknowledgement does not become a missing-reply error', async () => {
  const silent = { type: 'assistant', timestamp: '2026-08-05T04:13:00Z', message: { role: 'assistant', model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'No response requested.' }] } };
  const nextUser = { ...userPrompt, timestamp: '2026-08-05T04:14:00Z', message: { role: 'user', content: 'Continue.' } };
  const parsed = await parseNativeClaudeSessionFile(await writeNativeSession([userPrompt, silent, nextUser]));
  assert.equal(parsed?.messages.some(m => m.status === 'error'), false);
  assert.equal(parsed?.messages.some(m => m.content === 'No response requested.'), false);
});

await run('native Claude recovery preserves synthetic API errors as errors', async () => {
  const linkedUserPrompt = {
    ...userPrompt,
    uuid: 'user-prompt',
    parentUuid: null,
  };
  const finalAssistant = {
    type: 'assistant',
    timestamp: '2026-08-20T08:53:00.000Z',
    uuid: 'final-response',
    parentUuid: 'user-prompt',
    message: {
      role: 'assistant',
      model: 'claude-opus-5',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Compiled successfully. Committing:' }],
    },
  };
  const syntheticApiError = {
    type: 'assistant',
    timestamp: '2026-08-20T08:53:01.000Z',
    uuid: 'synthetic-api-error',
    parentUuid: 'final-response',
    isApiErrorMessage: true,
    message: {
      role: 'assistant',
      model: '<synthetic>',
      stop_reason: 'stop_sequence',
      content: [
        {
          type: 'text',
          text: 'API Error: Connection closed mid-response. The response above may be incomplete.',
        },
      ],
    },
  };
  const filePath = await writeNativeSession([
    linkedUserPrompt,
    finalAssistant,
    syntheticApiError,
  ]);
  const parsed = await parseNativeClaudeSessionFile(filePath);
  assert.ok(parsed);

  const assistantMessages = parsed.messages.filter((message) => message.role === 'assistant');
  assert.equal(assistantMessages[0]?.status, 'complete');
  assert.equal(assistantMessages[1]?.id, 'synthetic-api-error:assistant-text-0');
  assert.equal(assistantMessages[1]?.status, 'error');
  assert.equal(assistantMessages[1]?.title, 'Claude error');
  assert.equal(
    assistantMessages[1]?.content,
    'API Error: Connection closed mid-response. The response above may be incomplete.',
  );
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

await run('native Claude recovery marks a prior tool turn incomplete when a new prompt proves it ended', async () => {
  const nextUserPrompt = {
    ...userPrompt,
    timestamp: '2026-08-05T04:20:00.000Z',
    message: {
      role: 'user',
      content: 'Continue after the abandoned tool turn.',
    },
  };
  const filePath = await writeNativeSession([
    userPrompt,
    partialAssistant,
    toolResult,
    nextUserPrompt,
  ]);
  const parsed = await parseNativeClaudeSessionFile(filePath, {
    finalizeTrailingToolTurn: false,
  });
  assert.ok(parsed);

  assert.equal(
    parsed.messages.some((message) =>
      message.content.includes('without returning a final response'),
    ),
    true,
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
  assert.equal(parsed.messages.some((message) => message.status === 'error'), false);
  assert.equal(parsed.messages.at(-1)?.content, 'I am finishing the APT comparison.');
});
