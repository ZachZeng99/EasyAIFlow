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

const writeNativeSession = async (entries: Array<Record<string, unknown>>) => {
  const tempBase = path.resolve('.tmp-tests');
  await mkdir(tempBase, { recursive: true });
  const root = await mkdtemp(path.join(tempBase, 'native-claude-history-order-'));
  const filePath = path.join(root, 'session.jsonl');
  await writeFile(
    filePath,
    `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    'utf8',
  );
  return filePath;
};

const userEntry = (input: {
  uuid: string;
  parentUuid: string | null;
  timestamp: string;
  content: unknown;
}) => ({
  type: 'user',
  uuid: input.uuid,
  parentUuid: input.parentUuid,
  isSidechain: false,
  timestamp: input.timestamp,
  cwd: 'X:\\PBZ',
  sessionId: 'native-order-session',
  message: {
    role: 'user',
    content: input.content,
  },
});

const assistantEntry = (input: {
  uuid: string;
  parentUuid: string | null;
  timestamp: string;
  content: unknown;
  messageId?: string;
}) => ({
  type: 'assistant',
  uuid: input.uuid,
  parentUuid: input.parentUuid,
  isSidechain: false,
  timestamp: input.timestamp,
  cwd: 'X:\\PBZ',
  sessionId: 'native-order-session',
  message: {
    id: input.messageId ?? `message-${input.uuid}`,
    role: 'assistant',
    stop_reason: 'end_turn',
    model: 'claude-opus-4-6',
    content: input.content,
  },
});

await run('late retry chains retain successful execution before a follow-up instead of rewinding it', async () => {
  const user = userEntry({ uuid: 'user', parentUuid: null, timestamp: '2026-09-07T10:09:00Z', content: 'Run after reboot.' });
  const intro = assistantEntry({ uuid: 'intro', parentUuid: 'user', timestamp: '2026-09-07T10:09:01Z', content: [{ type: 'text', text: 'Checking the machine.' }] });
  const final = assistantEntry({ uuid: 'final', parentUuid: 'intro', timestamp: '2026-09-07T10:29:46Z', content: [{ type: 'text', text: 'The game is stuck at its main menu; no pawn exists.' }] });
  const retries = [
    { type: 'system', subtype: 'api_error', source: 'request_retry', uuid: 'retry-1', parentUuid: 'intro', timestamp: '2026-09-07T10:09:02Z', error: { message: 'Connection error.' }, retryAttempt: 1, maxRetries: 10 },
    { type: 'system', subtype: 'api_error', source: 'request_retry', uuid: 'retry-2', parentUuid: 'retry-1', timestamp: '2026-09-07T10:29:23Z', error: { message: 'Connection error.' }, retryAttempt: 2, maxRetries: 10 },
  ];
  const followup = userEntry({ uuid: 'followup', parentUuid: 'retry-2', timestamp: '2026-09-07T10:30:00Z', content: 'A' });
  const parsed = await parseNativeClaudeSessionFile(await writeNativeSession([user, intro, final, ...retries, followup]));
  assert.ok(parsed);
  assert.deepEqual(parsed.messages.map(m => m.content), ['Run after reboot.', 'Checking the machine.', 'The game is stuck at its main menu; no pawn exists.', 'A']);
  assert.equal(parsed.messages.some(m => m.status === 'error'), false);
});

await run('retry reattachment never crosses an abandoned user prompt', async () => {
  const records = [
    userEntry({ uuid: 'root', parentUuid: null, timestamp: '2026-09-07T10:00:00Z', content: 'Root prompt' }),
    assistantEntry({ uuid: 'root-answer', parentUuid: 'root', timestamp: '2026-09-07T10:00:01Z', content: [{ type: 'text', text: 'Root answer' }] }),
    userEntry({ uuid: 'abandoned', parentUuid: 'root-answer', timestamp: '2026-09-07T10:00:02Z', content: 'Abandoned prompt' }),
    assistantEntry({ uuid: 'abandoned-answer', parentUuid: 'abandoned', timestamp: '2026-09-07T10:00:04Z', content: [{ type: 'text', text: 'Abandoned answer' }] }),
    { type: 'system', subtype: 'api_error', source: 'request_retry', uuid: 'retry', parentUuid: 'root-answer', timestamp: '2026-09-07T10:00:03Z', error: { message: 'Connection error.' } },
    userEntry({ uuid: 'active', parentUuid: 'retry', timestamp: '2026-09-07T10:00:05Z', content: 'Replacement prompt' }),
  ];
  const parsed = await parseNativeClaudeSessionFile(await writeNativeSession(records));
  assert.ok(parsed);
  assert.equal(parsed.messages.some(m => m.content.includes('Abandoned')), false);
  assert.equal(parsed.messages.at(-1)?.content, 'Replacement prompt');
});

await run('native Claude hydration follows the newest UUID branch and keeps stable IDs', async () => {
  const entries = [
    userEntry({
      uuid: 'user-root',
      parentUuid: null,
      timestamp: '2026-08-09T01:00:00.000Z',
      content: 'Root prompt',
    }),
    assistantEntry({
      uuid: 'assistant-root',
      parentUuid: 'user-root',
      timestamp: '2026-08-09T01:00:01.000Z',
      content: [{ type: 'text', text: 'Root answer' }],
    }),
    userEntry({
      uuid: 'user-abandoned',
      parentUuid: 'assistant-root',
      timestamp: '2026-08-09T01:00:02.000Z',
      content: 'Abandoned branch prompt',
    }),
    assistantEntry({
      uuid: 'assistant-abandoned',
      parentUuid: 'user-abandoned',
      timestamp: '2026-08-09T01:00:03.000Z',
      content: [{ type: 'text', text: 'Abandoned branch answer' }],
    }),
    userEntry({
      uuid: 'user-active',
      parentUuid: 'assistant-root',
      timestamp: '2026-08-09T01:00:04.000Z',
      content: 'Active branch prompt',
    }),
    assistantEntry({
      uuid: 'assistant-active',
      parentUuid: 'user-active',
      timestamp: '2026-08-09T01:00:05.000Z',
      content: [{ type: 'text', text: 'Active branch answer' }],
    }),
  ];
  const filePath = await writeNativeSession(entries);

  const first = await parseNativeClaudeSessionFile(filePath);
  const second = await parseNativeClaudeSessionFile(filePath);
  assert.ok(first);
  assert.ok(second);

  assert.deepEqual(
    first.messages.map((message) => message.content),
    ['Root prompt', 'Root answer', 'Active branch prompt', 'Active branch answer'],
  );
  assert.equal(
    first.messages.some((message) => message.content.includes('Abandoned branch')),
    false,
  );
  assert.deepEqual(
    second.messages.map((message) => message.id),
    first.messages.map((message) => message.id),
  );
});

await run('native Claude hydration stitches a newest segment whose parent is missing', async () => {
  const entries = [
    userEntry({
      uuid: 'user-root',
      parentUuid: null,
      timestamp: '2026-08-19T11:00:00.000Z',
      content: 'Root prompt',
    }),
    assistantEntry({
      uuid: 'assistant-root',
      parentUuid: 'user-root',
      timestamp: '2026-08-19T11:00:01.000Z',
      content: [{ type: 'text', text: 'Root answer' }],
    }),
    userEntry({
      uuid: 'user-abandoned',
      parentUuid: 'assistant-root',
      timestamp: '2026-08-19T11:00:02.000Z',
      content: 'Abandoned branch prompt',
    }),
    assistantEntry({
      uuid: 'assistant-abandoned',
      parentUuid: 'user-abandoned',
      timestamp: '2026-08-19T11:00:03.000Z',
      content: [{ type: 'text', text: 'Abandoned branch answer' }],
    }),
    userEntry({
      uuid: 'user-active',
      parentUuid: 'assistant-root',
      timestamp: '2026-08-19T11:00:04.000Z',
      content: 'Active branch prompt',
    }),
    assistantEntry({
      uuid: 'assistant-active',
      parentUuid: 'user-active',
      timestamp: '2026-08-19T11:00:05.000Z',
      content: [{ type: 'text', text: 'Active branch answer' }],
    }),
    userEntry({
      uuid: 'user-after-restart',
      parentUuid: 'missing-resident-parent',
      timestamp: '2026-08-19T11:10:00.000Z',
      content: 'Prompt after resident restart',
    }),
    assistantEntry({
      uuid: 'assistant-after-restart',
      parentUuid: 'user-after-restart',
      timestamp: '2026-08-19T11:10:01.000Z',
      content: [{ type: 'text', text: 'Answer after resident restart' }],
    }),
  ];
  const filePath = await writeNativeSession(entries);

  const parsed = await parseNativeClaudeSessionFile(filePath);
  assert.ok(parsed);

  assert.deepEqual(
    parsed.messages.map((message) => message.content),
    [
      'Root prompt',
      'Root answer',
      'Active branch prompt',
      'Active branch answer',
      'Prompt after resident restart',
      'Answer after resident restart',
    ],
  );
  assert.equal(
    parsed.messages.some((message) => message.content.includes('Abandoned branch')),
    false,
  );
});

await run('native Claude hydration retains parallel tool siblings on the active branch', async () => {
  const filePath = await writeNativeSession([
    userEntry({
      uuid: 'parallel-user',
      parentUuid: null,
      timestamp: '2026-08-09T02:00:00.000Z',
      content: 'Run both checks',
    }),
    assistantEntry({
      uuid: 'parallel-assistant-a',
      parentUuid: 'parallel-user',
      timestamp: '2026-08-09T02:00:01.000Z',
      messageId: 'shared-assistant-message',
      content: [{ type: 'tool_use', id: 'tool-a', name: 'Read', input: { file_path: 'A.txt' } }],
    }),
    assistantEntry({
      uuid: 'parallel-assistant-b',
      parentUuid: 'parallel-assistant-a',
      timestamp: '2026-08-09T02:00:02.000Z',
      messageId: 'shared-assistant-message',
      content: [{ type: 'tool_use', id: 'tool-b', name: 'Read', input: { file_path: 'B.txt' } }],
    }),
    userEntry({
      uuid: 'parallel-result-a',
      parentUuid: 'parallel-assistant-a',
      timestamp: '2026-08-09T02:00:03.000Z',
      content: [{ type: 'tool_result', tool_use_id: 'tool-a', content: 'A result' }],
    }),
    userEntry({
      uuid: 'parallel-result-b',
      parentUuid: 'parallel-assistant-b',
      timestamp: '2026-08-09T02:00:04.000Z',
      content: [{ type: 'tool_result', tool_use_id: 'tool-b', content: 'B result' }],
    }),
    assistantEntry({
      uuid: 'parallel-final',
      parentUuid: 'parallel-result-b',
      timestamp: '2026-08-09T02:00:05.000Z',
      content: [{ type: 'text', text: 'Both checks completed' }],
    }),
  ]);

  const parsed = await parseNativeClaudeSessionFile(filePath);
  assert.ok(parsed);

  assert.deepEqual(
    parsed.messages.map((message) => [message.id, message.status]),
    [
      ['parallel-user', 'complete'],
      ['tool-a', 'success'],
      ['tool-b', 'success'],
      ['parallel-final:assistant-text-0', 'complete'],
    ],
  );
  assert.match(parsed.messages.find((message) => message.id === 'tool-a')?.content ?? '', /A result/);
  assert.match(parsed.messages.find((message) => message.id === 'tool-b')?.content ?? '', /B result/);
});
