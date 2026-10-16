import assert from 'node:assert/strict';
import { applyClaudeEventToProjects } from '../src/data/liveSessionEvents.ts';
import { mergeSessionSnapshot } from '../src/data/projectSnapshots.ts';
import { mergeOlderSessionMessagePage, replaceSessionHistoryAfterStaleCursor } from '../src/data/sessionHistoryCache.ts';
import type { ConversationMessage, ProjectRecord, SessionMessagesCommittedEvent, SessionRecord } from '../src/data/types.ts';

const run = (name: string, test: () => void) => {
  test();
  console.log(`PASS ${name}`);
};
const message = (id: string, content = id): ConversationMessage => ({
  id, content, role: 'assistant', timestamp: 'now', title: id, status: 'streaming',
});
const session = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  id: 's', title: 'Session', preview: '', timeLabel: 'now', updatedAt: 100,
  model: 'test', workspace: 'X:/repo', projectId: 'p', projectName: 'Project',
  dreamId: 'd', dreamName: 'Main', groups: [],
  tokenUsage: { contextWindow: 0, used: 0, input: 0, output: 0, cached: 0 },
  branchSnapshot: { branch: 'main', ahead: 0, behind: 0, dirty: false, changedFiles: [] },
  messagesLoaded: true, messageRevision: 1, messages: [message('a', 'hello')], ...overrides,
});
const commit = (revision: number, mutation: SessionMessagesCommittedEvent['mutation']): SessionMessagesCommittedEvent => ({
  type: 'messages-committed', sessionId: 's', revision, updatedAt: 200, mutation,
});
const apply = (value: SessionRecord, event: Parameters<typeof applyClaudeEventToProjects>[1]) => {
  const projects: ProjectRecord[] = [{ id: 'p', name: 'Project', rootPath: 'X:/repo', dreams: [{ id: 'd', name: 'Main', sessions: [value] }] }];
  return applyClaudeEventToProjects(projects, event)[0].dreams[0].sessions[0] as SessionRecord;
};

run('committed replacement text is idempotent and ignores legacy deltas', () => {
  const event = commit(2, { type: 'upsert-message', message: message('a', 'hello world') });
  const current = apply(session(), event);
  assert.equal(current.messages[0].content, 'hello world');
  assert.equal(current.messageRevision, 2);
  assert.equal(apply(current, event), current);
  assert.equal(apply(current, { type: 'delta', sessionId: 's', messageId: 'a', delta: ' world' }), current);
});

run('a missing revision requires a snapshot without applying out-of-order content', () => {
  let current = apply(session(), commit(3, { type: 'append-messages', messages: [message('c')] }));
  assert.equal(current.messageRevision, 1);
  assert.equal(current.requiredMessageRevision, 3);
  assert.deepEqual(current.messages.map((item) => item.id), ['a']);
  current = apply(current, commit(4, { type: 'upsert-message', message: message('c', 'finished') }));
  assert.equal(current.requiredMessageRevision, 4);
  current = mergeSessionSnapshot(current, session({ messageRevision: 3, messages: [message('a'), message('b'), message('c')] }));
  assert.equal(current.requiredMessageRevision, 4);
  current = mergeSessionSnapshot(current, session({ messageRevision: 4, messages: [message('a'), message('b'), message('c', 'finished')] }));
  assert.equal(current.requiredMessageRevision, undefined);
  assert.deepEqual(current.messages.map((item) => item.id), ['a', 'b', 'c']);
  assert.equal(current.messages[2].content, 'finished');
});

run('snapshot ordering uses durable revisions even with skewed client clocks', () => {
  const current = session({ updatedAt: 999999999 });
  const incoming = session({ updatedAt: 1, messageRevision: 2, messages: [message('a', 'server')] });
  const hydrated = mergeSessionSnapshot(current, incoming);
  assert.equal(hydrated.messages[0].content, 'server');
  assert.equal(mergeSessionSnapshot(hydrated, session({ updatedAt: 9999999999 })), hydrated);
});

run('snapshots racing live commits cannot roll back text or duplicate it', () => {
  const snapshot = session({ messageRevision: 2, messages: [message('a', 'hello world')] });
  let current = apply(snapshot, commit(3, { type: 'upsert-message', message: message('a', 'hello world!') }));
  current = mergeSessionSnapshot(current, snapshot);
  current = apply(current, commit(2, { type: 'upsert-message', message: message('a', 'hello world') }));
  assert.equal(current.messages[0].content, 'hello world!');
  assert.equal(current.messageRevision, 3);
});

run('unknown upserts and full replacements fetch bounded authoritative history', () => {
  const updated = apply(session(), commit(2, { type: 'upsert-message', message: message('old-page-item') }));
  assert.equal(updated.requiredMessageRevision, 2);
  assert.deepEqual(updated.messages.map((item) => item.id), ['a']);
  const replaced = apply(session(), commit(2, { type: 'replace-messages' }));
  assert.equal(replaced.requiredMessageRevision, 2);
});

run('unloaded and legacy sessions establish a snapshot before consuming commits', () => {
  const current = apply(session({ messageRevision: undefined, messagesLoaded: false, messages: [] }), commit(8, { type: 'append-messages', messages: [message('new')] }));
  assert.equal(current.requiredMessageRevision, 8);
  assert.deepEqual(current.messages, []);
  const hydrated = mergeSessionSnapshot(current, session({ messageRevision: 8 }));
  assert.equal(hydrated.requiredMessageRevision, undefined);
  assert.equal(hydrated.messagesLoaded, true);
});

run('summary refresh preserves loaded revision and pending recovery', () => {
  const current = session({ requiredMessageRevision: 4 });
  const merged = mergeSessionSnapshot(current, session({ messageRevision: undefined, messagesLoaded: false, messages: [] }));
  assert.equal(merged.messageRevision, 1);
  assert.equal(merged.requiredMessageRevision, 4);
  assert.equal(merged.messages[0].content, 'hello');
  const unloaded = session({ messagesLoaded: false, messages: [], requiredMessageRevision: 4 });
  const stillPending = mergeSessionSnapshot(unloaded, session({ messageRevision: undefined, messagesLoaded: false, messages: [] }));
  assert.equal(stillPending.requiredMessageRevision, 4);
});

run('reconnect invalidates every cached revisioned session even without another commit', () => {
  const current = apply(session(), { type: 'interaction-sync' });
  assert.equal(current.requiredMessageRevision, 1);
  const recovered = mergeSessionSnapshot(current, session({ messageRevision: 2, messages: [message('a', 'offline final')] }));
  assert.equal(recovered.requiredMessageRevision, undefined);
  assert.equal(recovered.messages[0].content, 'offline final');
});

run('append commits preserve server order and shorten bodies when corrected', () => {
  let current = apply(session(), commit(2, { type: 'append-messages', messages: [message('b'), message('c')] }));
  current = apply(current, commit(3, { type: 'upsert-message', message: message('a', 'hi') }));
  assert.deepEqual(current.messages.map((item) => item.id), ['a', 'b', 'c']);
  assert.equal(current.messages[0].content, 'hi');
});

run('stale pagination cannot resurrect removed messages after replacement', () => {
  const current = session({ messageRevision: 4 });
  const merged = mergeOlderSessionMessagePage(current, { sessionId: 's', pageId: 'old', sessionRevision: 2, hasMoreBefore: false, messages: [message('removed')] });
  assert.equal(merged, current);
  const restored = replaceSessionHistoryAfterStaleCursor(current, session({ messageRevision: 5, messages: [message('a', 'recovered')] }));
  assert.equal(restored.messages[0].content, 'recovered');
  assert.equal(restored.messageRevision, 5);
});
