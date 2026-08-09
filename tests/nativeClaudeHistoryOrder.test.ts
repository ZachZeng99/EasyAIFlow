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
