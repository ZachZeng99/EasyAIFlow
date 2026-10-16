import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { migrateSessionStoreV2, openSessionStoreV2, getSessionStoreV2Paths } from '../electron/sessionStoreV2.ts';
import { applyCommittedSessionMessages } from '../src/data/committedSessionMessages.ts';
import { mergeSessionSnapshot } from '../src/data/projectSnapshots.ts';
import type { SessionStoreAppState } from '../electron/sessionStoreMerge.ts';
import type { ConversationMessage, SessionMessagesCommittedEvent, SessionRecord } from '../src/data/types.ts';

const run = async (name: string, test: () => Promise<void>) => {
  await test();
  console.log(`PASS ${name}`);
};
const message = (id: string, content = id): ConversationMessage => ({
  id, content, role: 'assistant', timestamp: 'now', title: id, status: 'streaming',
});
const makeState = (): SessionStoreAppState => ({
  projects: [{ id: 'p', name: 'Project', rootPath: 'X:/repo', dreams: [{ id: 'd', name: 'Main', sessions: [{
    id: 's', title: 'Session', preview: '', timeLabel: 'now', updatedAt: 1,
    model: 'test', workspace: 'X:/repo', projectId: 'p', projectName: 'Project',
    dreamId: 'd', dreamName: 'Main', groups: [], messages: [message('a', 'start')],
    tokenUsage: { contextWindow: 0, used: 0, input: 0, output: 0, cached: 0 },
    branchSnapshot: { branch: 'main', ahead: 0, behind: 0, dirty: false, changedFiles: [] },
  } as SessionRecord] }] }],
  deletedImports: { claudeSessionIds: [], codexThreadIds: [] },
});
const root = async () => {
  const base = path.resolve('.tmp-tests');
  await mkdir(base, { recursive: true });
  return mkdtemp(path.join(base, 'message-commits-'));
};

await run('commit notifications follow durable writes and freeze caller-owned messages', async () => {
  const directory = await root();
  const events: SessionMessagesCommittedEvent[] = [];
  const persistedRevisions: number[] = [];
  const state = makeState();
  const store = await migrateSessionStoreV2(directory, state, {
    maxMessages: 0,
    onMessagesCommitted(event) {
      events.push(event);
      const paths = getSessionStoreV2Paths(directory, 's');
      const journal = readFileSync(paths.eventsPath, 'utf8');
      persistedRevisions.push(...journal.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line).revision));
    },
  });
  events.length = 0;
  const original = message('a', 'captured');
  const save = store.persist(state, { sessionMutations: [{ type: 'upsert-message', sessionId: 's', message: original }], immediateIndex: true });
  original.content = 'mutated after submission';
  await save;
  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event.mutation.type, 'upsert-message');
  if (event.mutation.type !== 'upsert-message') throw new Error('Wrong mutation');
  assert.equal(event.mutation.message.content, 'captured');
  assert.ok(persistedRevisions.includes(event.revision));
  const page = await store.readMessagePage('s');
  assert.equal(page.messages[0].content, 'captured');
  assert.equal(page.sessionRevision, event.revision);
  await store.flush(state);
});

await run('revisions survive reopen and two clients converge after an omitted event', async () => {
  const directory = await root();
  const state = makeState();
  const events: SessionMessagesCommittedEvent[] = [];
  let store = await migrateSessionStoreV2(directory, state, { maxMessages: 0, onMessagesCommitted: (event) => events.push(event) });
  const firstPage = await store.readMessagePage('s');
  const initial = state.projects[0].dreams[0].sessions[0] as SessionRecord;
  let desktop: SessionRecord = { ...initial, messages: firstPage.messages, messagesLoaded: true, messageRevision: firstPage.sessionRevision };
  let mobile = desktop;
  events.length = 0;
  await store.persist(state, { sessionMutations: [{ type: 'append-messages', sessionId: 's', messages: [message('b')] }], immediateIndex: true });
  desktop = applyCommittedSessionMessages(desktop, events.at(-1)!);
  await store.flush(state);
  const reopened = await openSessionStoreV2(directory, { maxMessages: 0, onMessagesCommitted: (event) => events.push(event) });
  assert.ok(reopened);
  store = reopened.store;
  await store.persist(reopened.state, { sessionMutations: [{ type: 'upsert-message', sessionId: 's', message: message('b', 'finished') }], immediateIndex: true });
  const latest = events.at(-1)!;
  assert.equal(latest.revision, firstPage.sessionRevision + 2);
  desktop = applyCommittedSessionMessages(desktop, latest);
  mobile = applyCommittedSessionMessages(mobile, JSON.parse(JSON.stringify(latest)));
  assert.equal(mobile.requiredMessageRevision, latest.revision);
  const page = await store.readMessagePage('s');
  mobile = mergeSessionSnapshot(mobile, { ...initial, messagesLoaded: true, messages: page.messages, messageRevision: page.sessionRevision });
  assert.deepEqual(mobile.messages, desktop.messages);
  assert.equal(applyCommittedSessionMessages(mobile, latest), mobile);
  await store.flush(reopened.state);
});

await run('history replacements invalidate clients without broadcasting entire histories', async () => {
  const directory = await root();
  const state = makeState();
  const events: SessionMessagesCommittedEvent[] = [];
  const store = await migrateSessionStoreV2(directory, state, { maxMessages: 0, onMessagesCommitted: (event) => events.push(event) });
  events.length = 0;
  await store.persist(state, { sessionMutations: [{ type: 'replace-messages', sessionId: 's', messages: [message('replacement', 'x'.repeat(20000))] }], immediateIndex: true });
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].mutation, { type: 'replace-messages' });
  assert.ok(JSON.stringify(events[0]).length < 250);
  const page = await store.readMessagePage('s');
  assert.equal(page.sessionRevision, events[0].revision);
  assert.equal(page.messages[0].id, 'replacement');
  await store.flush(state);
});

await run('failed persistence does not publish a successful message commit', async () => {
  const directory = await root();
  const state = makeState();
  const events: SessionMessagesCommittedEvent[] = [];
  const store = await migrateSessionStoreV2(directory, state, { maxMessages: 0, onMessagesCommitted: (event) => events.push(event) });
  events.length = 0;
  const journal = getSessionStoreV2Paths(directory, 's').eventsPath;
  await rm(journal, { force: true });
  await mkdir(journal);
  await assert.rejects(store.persist(state, { sessionMutations: [{ type: 'upsert-message', sessionId: 's', message: message('a', 'not persisted') }] }));
  assert.deepEqual(events, []);
});
