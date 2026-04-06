import assert from 'node:assert/strict';
import {
  recoverStaleSessionMessages,
  recoverStaleSessionMessagesForProvider,
} from '../electron/sessionRecovery.ts';
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

const makeMessage = (overrides: Partial<ConversationMessage>): ConversationMessage => ({
  id: overrides.id ?? 'm1',
  role: overrides.role ?? 'system',
  kind: overrides.kind,
  timestamp: overrides.timestamp ?? 'now',
  title: overrides.title ?? 'Title',
  content: overrides.content ?? 'Body',
  status: overrides.status,
});

run('recoverStaleSessionMessages completes stale progress messages', () => {
  const [message] = recoverStaleSessionMessages([
    makeMessage({ kind: 'progress', status: 'running', content: 'Progress update' }),
  ]);

  assert.equal(message.status, 'complete');
});

run('recoverStaleSessionMessages marks empty streaming assistant messages as error', () => {
  const [message] = recoverStaleSessionMessages([
    makeMessage({ role: 'assistant', kind: 'message', status: 'streaming', title: 'Claude response', content: '' }),
  ]);

  assert.equal(message.status, 'error');
  assert.equal(message.title, 'Claude error');
  assert.equal(message.content, 'Previous Claude run did not finish.');
});

run('recoverStaleSessionMessages completes non-empty streaming assistant messages', () => {
  const [message] = recoverStaleSessionMessages([
    makeMessage({ role: 'assistant', kind: 'message', status: 'streaming', content: 'partial reply' }),
  ]);

  assert.equal(message.status, 'complete');
  assert.equal(message.content, 'partial reply');
});

run('recoverStaleSessionMessages marks queued assistant messages as interrupted', () => {
  const [message] = recoverStaleSessionMessages([
    makeMessage({ role: 'assistant', kind: 'message', status: 'queued', title: 'Claude queued' }),
  ]);

  assert.equal(message.status, 'error');
  assert.equal(message.title, 'Claude queue interrupted');
  assert.equal(message.content, 'Queued Claude run did not resume after restart.');
});

run('recoverStaleSessionMessagesForProvider uses provider-specific recovery copy', () => {
  const [message] = recoverStaleSessionMessagesForProvider(
    [makeMessage({ role: 'assistant', kind: 'message', status: 'queued', title: 'Codex queued' })],
    'codex',
  );

  assert.equal(message.status, 'error');
  assert.equal(message.title, 'Codex queue interrupted');
  assert.equal(message.content, 'Queued Codex run did not resume after restart.');
});
