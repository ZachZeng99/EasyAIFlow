import assert from 'node:assert/strict';
import {
  evictSessionHistories,
  isStaleSessionHistoryCursorError,
  mergeOlderSessionMessagePage,
  replaceSessionHistoryAfterStaleCursor,
  touchSessionHistory,
} from '../src/data/sessionHistoryCache.ts';
import type { ProjectRecord, SessionMessagePage, SessionRecord } from '../src/data/types.ts';

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

const makeSession = (id: string): SessionRecord => ({
  id,
  title: id,
  preview: id,
  timeLabel: 'now',
  updatedAt: 1,
  provider: 'codex',
  model: 'gpt-5',
  workspace: 'X:\\workspace',
  projectId: 'project',
  projectName: 'Project',
  dreamId: 'dream',
  dreamName: 'Dream',
  groups: [],
  contextReferences: [],
  tokenUsage: { contextWindow: 0, used: 0, input: 0, output: 0, cached: 0, windowSource: 'unknown' },
  branchSnapshot: { branch: 'main', ahead: 0, behind: 0, dirty: false, changedFiles: [] },
  messagesLoaded: true,
  messages: [{ id: `${id}-message`, role: 'assistant', timestamp: 'now', title: id, content: id }],
  historyPage: { nextBefore: `${id}-older`, hasMoreBefore: true, sessionRevision: 1 },
});

run('older pages prepend chronologically without duplicating live messages', () => {
  const session = makeSession('selected');
  session.messages = [
    { id: 'm2', role: 'assistant', timestamp: 'now', title: 'm2', content: 'm2' },
    { id: 'm3', role: 'assistant', timestamp: 'now', title: 'm3', content: 'live m3' },
  ];
  const page: SessionMessagePage = {
    sessionId: session.id,
    pageId: 'older-page',
    messages: [
      { id: 'm1', role: 'user', timestamp: 'then', title: 'm1', content: 'm1' },
      { id: 'm2', role: 'assistant', timestamp: 'then', title: 'm2', content: 'stale m2' },
    ],
    hasMoreBefore: false,
    sessionRevision: 2,
  };

  const merged = mergeOlderSessionMessagePage(session, page);
  assert.deepEqual(merged.messages.map((message) => message.id), ['m1', 'm2', 'm3']);
  assert.equal(merged.messages[1]?.content, 'm2');
  assert.equal(merged.historyPage?.hasMoreBefore, false);
});

run('LRU keeps selected, pinned, and two recent inactive sessions only', () => {
  const sessions = ['selected', 'pinned', 'recent-a', 'recent-b', 'old-a', 'old-b'].map(makeSession);
  const projects: ProjectRecord[] = [{
    id: 'project',
    name: 'Project',
    rootPath: 'X:\\workspace',
    dreams: [{ id: 'dream', name: 'Dream', sessions }],
  }];
  let recency: string[] = [];
  for (const id of ['old-b', 'recent-b', 'recent-a']) {
    recency = touchSessionHistory(recency, id);
  }
  const evicted = evictSessionHistories(projects, {
    selectedSessionId: 'selected',
    pinnedSessionIds: new Set(['pinned']),
    recency,
    retainRecentInactive: 2,
  });
  const byId = new Map(
    evicted[0]!.dreams[0]!.sessions.map((session) => [session.id, session as SessionRecord]),
  );

  for (const id of ['selected', 'pinned', 'recent-a', 'recent-b']) {
    assert.equal(byId.get(id)?.messagesLoaded, true, id);
    assert.equal(byId.get(id)?.messages.length, 1, id);
  }
  for (const id of ['old-a', 'old-b']) {
    assert.equal(byId.get(id)?.messagesLoaded, false, id);
    assert.deepEqual(byId.get(id)?.messages, [], id);
    assert.equal(byId.get(id)?.historyPage, undefined, id);
    assert.equal(byId.get(id)?.title, id, id);
  }
});

run('stale cursors reload bounded history without dropping live messages', () => {
  const current = makeSession('selected');
  current.messages = [
    { id: 'old-page', role: 'assistant', timestamp: 'then', title: 'old', content: 'old' },
    { id: 'live', role: 'assistant', timestamp: 'now', title: 'live', content: 'partial', status: 'streaming' },
  ];
  const reloaded = makeSession('selected');
  reloaded.messages = [
    { id: 'new-page', role: 'assistant', timestamp: 'now', title: 'new', content: 'new' },
  ];
  reloaded.historyPage = { nextBefore: 'new-older', hasMoreBefore: true, sessionRevision: 3 };

  const merged = replaceSessionHistoryAfterStaleCursor(current, reloaded);
  assert.deepEqual(merged.messages.map((message) => message.id), ['new-page', 'live']);
  assert.equal(merged.historyPage?.nextBefore, 'new-older');
  assert.equal(
    isStaleSessionHistoryCursorError(new Error('Stale history cursor "old" for session "selected".')),
    true,
  );
});
