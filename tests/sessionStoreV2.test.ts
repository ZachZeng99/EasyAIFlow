import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFile, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ConversationMessage, SessionRecord } from '../src/data/types.js';
import type { SessionStoreAppState } from '../electron/sessionStoreMerge.js';
import {
  getSessionStoreV2Paths,
  migrateSessionStoreV2,
  openSessionStoreV2,
  parseSessionStoreV2EventLog,
  replaySessionStoreV2Events,
  type SessionStoreV2Event,
} from '../electron/sessionStoreV2.js';

const run = async (name: string, fn: () => void | Promise<void>) => {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

const message = (id: string, content = id): ConversationMessage => ({
  id,
  role: 'assistant',
  timestamp: 'Just now',
  title: id,
  content,
  status: 'complete',
});

const session = (id: string, messages: ConversationMessage[] = []): SessionRecord => ({
  id,
  title: id,
  preview: '',
  timeLabel: 'Just now',
  updatedAt: 1,
  provider: 'codex',
  model: 'gpt-5',
  workspace: 'X:\\workspace',
  projectId: 'project-1',
  projectName: 'Project',
  dreamId: 'dream-1',
  dreamName: 'Dream',
  sessionKind: 'standard',
  hidden: false,
  groups: [],
  contextReferences: [],
  tokenUsage: {
    contextWindow: 0,
    used: 0,
    input: 0,
    output: 0,
    cached: 0,
    windowSource: 'unknown',
  },
  branchSnapshot: {
    branch: 'main',
    ahead: 0,
    behind: 0,
    dirty: false,
    changedFiles: [],
  },
  messages,
});

const stateWithSessions = (sessions: SessionRecord[]): SessionStoreAppState => ({
  projects: [
    {
      id: 'project-1',
      name: 'Project',
      rootPath: 'X:\\workspace',
      dreams: [
        {
          id: 'dream-1',
          name: 'Dream',
          sessions,
        },
      ],
    },
  ],
  deletedImports: {
    claudeSessionIds: [],
    codexThreadIds: [],
  },
});

await run('replays only events newer than the snapshot and caps the result', () => {
  const events: SessionStoreV2Event[] = [
    {
      schemaVersion: 2,
      sessionId: 'session-1',
      revision: 2,
      type: 'append-messages',
      messages: [message('covered')],
    },
    {
      schemaVersion: 2,
      sessionId: 'session-1',
      revision: 3,
      type: 'append-messages',
      messages: [message('m2'), message('m3')],
    },
    {
      schemaVersion: 2,
      sessionId: 'session-1',
      revision: 4,
      type: 'upsert-message',
      message: message('m2', 'updated'),
    },
  ];

  const replayed = replaySessionStoreV2Events(
    {
      schemaVersion: 2,
      sessionId: 'session-1',
      revision: 2,
      messages: [message('m0'), message('m1')],
    },
    events,
    3,
  );

  assert.equal(replayed.revision, 4);
  assert.deepEqual(replayed.messages.map((item) => item.id), ['m1', 'm2', 'm3']);
  assert.equal(replayed.messages[1]?.content, 'updated');
});

await run('replace-messages events replace the previous snapshot exactly once', () => {
  const replacement: SessionStoreV2Event = {
    schemaVersion: 2,
    sessionId: 'session-1',
    revision: 8,
    type: 'replace-messages',
    messages: [message('replacement')],
  };
  const replayed = replaySessionStoreV2Events(
    {
      schemaVersion: 2,
      sessionId: 'session-1',
      revision: 7,
      messages: [message('old')],
    },
    [replacement, replacement],
    400,
  );

  assert.equal(replayed.revision, 8);
  assert.deepEqual(replayed.messages.map((item) => item.id), ['replacement']);
});

await run('ignores an incomplete final JSONL line', () => {
  const valid: SessionStoreV2Event = {
    schemaVersion: 2,
    sessionId: 'session-1',
    revision: 1,
    type: 'append-messages',
    messages: [message('m1')],
  };
  const parsed = parseSessionStoreV2EventLog(`${JSON.stringify(valid)}\n{"schemaVersion":2`);

  assert.deepEqual(parsed, [valid]);
});

await run('rejects a malformed non-final JSONL line', () => {
  assert.throws(
    () => parseSessionStoreV2EventLog('{broken}\n{"also":"broken"}\n'),
    /Malformed session event log line 1/,
  );
});

await run('opens only the catalog and reads session history one bounded page at a time', async () => {
  const root = await mkdtemp(path.join(path.resolve('.tmp-tests'), 'session-store-v2-pages-'));
  await mkdir(root, { recursive: true });
  const messages = Array.from({ length: 250 }, (_, index) => message(`m${index}`));
  const state = stateWithSessions([session('session-1', messages)]);
  await migrateSessionStoreV2(root, state, { maxMessages: 0 });

  const opened = await openSessionStoreV2(root, { maxMessages: 0 });
  const catalogSession = opened?.state.projects[0]?.dreams[0]?.sessions[0] as SessionRecord | undefined;
  assert.deepEqual(catalogSession?.messages, []);
  assert.equal(catalogSession?.messagesLoaded, false);

  const newest = await opened!.store.readMessagePage('session-1');
  assert.equal(newest.messages.length, 50);
  assert.deepEqual(newest.messages.map((item) => item.id), messages.slice(200).map((item) => item.id));
  assert.equal(newest.hasMoreBefore, true);
  assert.ok(newest.nextBefore);

  const middle = await opened!.store.readMessagePage('session-1', newest.nextBefore);
  const oldest = await opened!.store.readMessagePage('session-1', middle.nextBefore);
  assert.deepEqual(
    [...oldest.messages, ...middle.messages, ...newest.messages].map((item) => item.id),
    messages.map((item) => item.id),
  );
  assert.equal(oldest.hasMoreBefore, false);
  assert.equal(oldest.nextBefore, undefined);
});

await run('isolates a message larger than the page byte budget without losing it', async () => {
  const root = await mkdtemp(path.join(path.resolve('.tmp-tests'), 'session-store-v2-oversize-'));
  await mkdir(root, { recursive: true });
  const oversized = message('oversized', 'x'.repeat(5 * 1024 * 1024 + 1));
  const state = stateWithSessions([session('session-1', [message('before'), oversized, message('after')])]);
  await migrateSessionStoreV2(root, state, { maxMessages: 0 });

  const opened = await openSessionStoreV2(root, { maxMessages: 0 });
  const newest = await opened!.store.readMessagePage('session-1');
  const oversizedPage = await opened!.store.readMessagePage('session-1', newest.nextBefore);
  const oldest = await opened!.store.readMessagePage('session-1', oversizedPage.nextBefore);

  assert.deepEqual(newest.messages.map((item) => item.id), ['after']);
  assert.deepEqual(oversizedPage.messages.map((item) => item.id), ['oversized']);
  assert.deepEqual(oldest.messages.map((item) => item.id), ['before']);
  assert.equal(oversizedPage.messages[0]?.content.length, oversized.content.length);
});

await run('persists one session event without rewriting unrelated snapshots', async () => {
  const root = await mkdtemp(path.join(path.resolve('.tmp-tests'), 'session-store-v2-write-'));
  await mkdir(root, { recursive: true });
  const first = session('session-1', [message('first')]);
  const second = session('session-2', [message('unrelated')]);
  const state = stateWithSessions([first, second]);
  const store = await migrateSessionStoreV2(root, state, {
    maxMessages: 400,
    compactionEventCount: 100,
    compactionBytes: 1024 * 1024,
  });
  const unrelatedPaths = getSessionStoreV2Paths(root, second.id);
  const unrelatedPageName = (await readdir(unrelatedPaths.pagesPath))[0];
  const unrelatedMetaBefore = await stat(unrelatedPaths.metaPath);
  const unrelatedPageBefore = await stat(path.join(unrelatedPaths.pagesPath, unrelatedPageName));

  const appended = message('second');
  first.messages.push(appended);
  first.updatedAt = 2;
  await store.persist(state, {
    sessionMutations: [
      {
        type: 'append-messages',
        sessionId: first.id,
        messages: [appended],
      },
    ],
    immediateIndex: true,
  });
  await store.flush(state);

  const unrelatedMetaAfter = await stat(unrelatedPaths.metaPath);
  const unrelatedPageAfter = await stat(path.join(unrelatedPaths.pagesPath, unrelatedPageName));
  const activePaths = getSessionStoreV2Paths(root, first.id);
  const eventLog = await readFile(activePaths.eventsPath, 'utf8');
  const loaded = await openSessionStoreV2(root, { maxMessages: 400 });
  const loadedFirst = loaded?.state.projects[0]?.dreams[0]?.sessions[0] as SessionRecord | undefined;
  const loadedFirstPage = await loaded!.store.readMessagePage(first.id);

  assert.equal(unrelatedMetaAfter.mtimeMs, unrelatedMetaBefore.mtimeMs);
  assert.equal(unrelatedPageAfter.mtimeMs, unrelatedPageBefore.mtimeMs);
  assert.equal(parseSessionStoreV2EventLog(eventLog).length, 0);
  assert.deepEqual(loadedFirst?.messages, []);
  assert.deepEqual(loadedFirstPage.messages.map((item) => item.id), ['first', 'second']);
});

await run('does not rewrite an empty event log while reading clean pages', async () => {
  const root = await mkdtemp(path.join(path.resolve('.tmp-tests'), 'session-store-v2-clean-read-'));
  await mkdir(root, { recursive: true });
  const target = session('session-1', [message('first')]);
  const state = stateWithSessions([target]);
  await migrateSessionStoreV2(root, state, { maxMessages: 0 });
  const paths = getSessionStoreV2Paths(root, target.id);
  const before = await stat(paths.eventsPath);

  const opened = await openSessionStoreV2(root, { maxMessages: 0 });
  await opened!.store.readMessagePage(target.id);

  const after = await stat(paths.eventsPath);
  assert.deepEqual(
    { mtimeMs: after.mtimeMs, size: after.size },
    { mtimeMs: before.mtimeMs, size: before.size },
  );
});

await run('persists empty page metadata when a new session enters the catalog', async () => {
  const root = await mkdtemp(path.join(path.resolve('.tmp-tests'), 'session-store-v2-new-session-'));
  await mkdir(root, { recursive: true });
  const initial = session('initial-session');
  const state = stateWithSessions([initial]);
  const store = await migrateSessionStoreV2(root, state, { maxMessages: 0 });
  const added = session('added-session');
  state.projects[0]!.dreams[0]!.sessions.push(added);

  await store.persist(state, { immediateIndex: true });

  const addedPaths = getSessionStoreV2Paths(root, added.id);
  const meta = JSON.parse(await readFile(addedPaths.metaPath, 'utf8')) as {
    messageCount: number;
    revision: number;
  };
  assert.deepEqual(meta, {
    schemaVersion: 2,
    sessionId: added.id,
    revision: 0,
    messageCount: 0,
    pages: [],
    messagePageById: {},
  });
});

await run('initializes an empty page store for a catalog-only session', async () => {
  const root = await mkdtemp(path.join(path.resolve('.tmp-tests'), 'session-store-v2-catalog-only-'));
  await mkdir(root, { recursive: true });
  const target = session('session-1');
  const state = stateWithSessions([target]);
  await migrateSessionStoreV2(root, state, { maxMessages: 0 });
  const paths = getSessionStoreV2Paths(root, target.id);
  await rm(paths.sessionPath, { recursive: true, force: true });

  const opened = await openSessionStoreV2(root, { maxMessages: 0 });
  const newest = await opened!.store.readMessagePage(target.id);
  const meta = JSON.parse(await readFile(paths.metaPath, 'utf8')) as { messageCount: number };

  assert.deepEqual(newest.messages, []);
  assert.equal(meta.messageCount, 0);
});

await run('recovers a journal-only V2 session before the first page compaction', async () => {
  const root = await mkdtemp(path.join(path.resolve('.tmp-tests'), 'session-store-v2-journal-only-'));
  await mkdir(root, { recursive: true });
  const target = session('session-1');
  const state = stateWithSessions([target]);
  await migrateSessionStoreV2(root, state, { maxMessages: 0 });
  const paths = getSessionStoreV2Paths(root, target.id);
  await rm(paths.sessionPath, { recursive: true, force: true });
  await mkdir(paths.sessionPath, { recursive: true });
  const event: SessionStoreV2Event = {
    schemaVersion: 2,
    sessionId: target.id,
    revision: 1,
    type: 'append-messages',
    messages: [message('journal-message')],
  };
  await writeFile(paths.eventsPath, `${JSON.stringify(event)}\n`, 'utf8');

  const opened = await openSessionStoreV2(root, { maxMessages: 0 });
  const newest = await opened!.store.readMessagePage(target.id);

  assert.deepEqual(newest.messages.map((item) => item.id), ['journal-message']);
  assert.equal(await readFile(paths.eventsPath, 'utf8'), '');
  assert.equal((JSON.parse(await readFile(paths.metaPath, 'utf8')) as { revision: number }).revision, 1);
});

await run('lazily upgrades legacy V2 snapshots and pending events to page storage', async () => {
  const root = await mkdtemp(path.join(path.resolve('.tmp-tests'), 'session-store-v2-legacy-snapshot-'));
  await mkdir(root, { recursive: true });
  const target = session('session-1', [message('ignored-page-layout')]);
  const state = stateWithSessions([target]);
  await migrateSessionStoreV2(root, state, { maxMessages: 0 });
  const paths = getSessionStoreV2Paths(root, target.id);
  await rm(paths.metaPath, { force: true });
  await rm(`${paths.metaPath}.previous`, { force: true });

  await writeFile(paths.snapshotPath, JSON.stringify({
    schemaVersion: 2,
    sessionId: target.id,
    revision: 1,
    messages: [message('m0'), message('m1', 'before-upsert')],
  }), 'utf8');
  const events: SessionStoreV2Event[] = [
    {
      schemaVersion: 2,
      sessionId: target.id,
      revision: 2,
      type: 'append-messages',
      messages: [message('m2')],
    },
    {
      schemaVersion: 2,
      sessionId: target.id,
      revision: 3,
      type: 'upsert-message',
      message: message('m1', 'after-upsert'),
    },
  ];
  await writeFile(paths.eventsPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');

  const opened = await openSessionStoreV2(root, { maxMessages: 0 });
  const newest = await opened!.store.readMessagePage(target.id);
  const meta = JSON.parse(await readFile(paths.metaPath, 'utf8')) as { revision: number };

  assert.deepEqual(newest.messages.map((item) => item.id), ['m0', 'm1', 'm2']);
  assert.equal(newest.messages[1]?.content, 'after-upsert');
  assert.equal(meta.revision, 3);
  assert.equal(await readFile(paths.eventsPath, 'utf8'), '');
  await assert.rejects(() => stat(paths.snapshotPath), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
});

await run('repairs an incomplete crash tail before appending the next event', async () => {
  const root = await mkdtemp(path.join(path.resolve('.tmp-tests'), 'session-store-v2-tail-repair-'));
  await mkdir(root, { recursive: true });
  const target = session('session-1', [message('first')]);
  const state = stateWithSessions([target]);
  await migrateSessionStoreV2(root, state, { maxMessages: 0 });
  const paths = getSessionStoreV2Paths(root, target.id);
  await appendFile(paths.eventsPath, '{"schemaVersion":2,"sessionId":"session-1"', 'utf8');

  const opened = await openSessionStoreV2(root, { maxMessages: 0 });
  const appended = message('after-crash');
  target.messages.push(appended);
  await opened!.store.persist(state, {
    sessionMutations: [{ type: 'append-messages', sessionId: target.id, messages: [appended] }],
  });
  await opened!.store.flush(state);

  const page = await opened!.store.readMessagePage(target.id);
  assert.deepEqual(page.messages.map((item) => item.id), ['first', 'after-crash']);
  assert.equal(await readFile(paths.eventsPath, 'utf8'), '');
});

await run('isolates missing page metadata to the corrupted session', async () => {
  const root = await mkdtemp(path.join(path.resolve('.tmp-tests'), 'session-store-v2-missing-meta-'));
  await mkdir(root, { recursive: true });
  const broken = session('broken', [message('broken-message')]);
  const healthy = session('healthy', [message('healthy-message')]);
  const state = stateWithSessions([broken, healthy]);
  await migrateSessionStoreV2(root, state, { maxMessages: 0 });
  const brokenPaths = getSessionStoreV2Paths(root, broken.id);
  await rm(brokenPaths.metaPath, { force: true });
  await rm(`${brokenPaths.metaPath}.previous`, { force: true });

  const opened = await openSessionStoreV2(root, { maxMessages: 0 });
  await assert.rejects(
    () => opened!.store.readMessagePage(broken.id),
    /Missing V2 page metadata for session "broken"/,
  );
  assert.equal(
    (await opened!.store.readMessagePage(healthy.id)).messages[0]?.id,
    'healthy-message',
  );
});

await run('compacts a session log and ignores duplicate covered events after restart', async () => {
  const root = await mkdtemp(path.join(path.resolve('.tmp-tests'), 'session-store-v2-compact-'));
  await mkdir(root, { recursive: true });
  const target = session('session-1');
  const state = stateWithSessions([target]);
  const store = await migrateSessionStoreV2(root, state, {
    maxMessages: 400,
    compactionEventCount: 2,
    compactionBytes: Number.MAX_SAFE_INTEGER,
  });

  for (const id of ['m1', 'm2']) {
    const appended = message(id);
    target.messages.push(appended);
    await store.persist(state, {
      sessionMutations: [
        {
          type: 'append-messages',
          sessionId: target.id,
          messages: [appended],
        },
      ],
      immediateIndex: false,
    });
  }
  await store.flush(state);

  const paths = getSessionStoreV2Paths(root, target.id);
  const meta = JSON.parse(await readFile(paths.metaPath, 'utf8')) as {
    revision: number;
  };
  const coveredEvent: SessionStoreV2Event = {
    schemaVersion: 2,
    sessionId: target.id,
    revision: meta.revision,
    type: 'append-messages',
    messages: [message('duplicate')],
  };
  await appendFile(paths.eventsPath, `${JSON.stringify(coveredEvent)}\n`, 'utf8');

  const loaded = await openSessionStoreV2(root, { maxMessages: 400 });
  const loadedTarget = loaded?.state.projects[0]?.dreams[0]?.sessions[0] as SessionRecord | undefined;
  const loadedPage = await loaded!.store.readMessagePage(target.id);
  assert.equal(meta.revision, 2);
  assert.deepEqual(loadedTarget?.messages, []);
  assert.deepEqual(loadedPage.messages.map((item) => item.id), ['m1', 'm2']);
});

await run('rejects a second live writer and recovers its stale lock after exit', async () => {
  const root = await mkdtemp(path.join(path.resolve('.tmp-tests'), 'session-store-v2-lock-'));
  await mkdir(root, { recursive: true });
  const state = stateWithSessions([session('session-1')]);
  await migrateSessionStoreV2(root, state, { maxMessages: 0 });
  const paths = getSessionStoreV2Paths(root);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  assert.ok(child.pid);
  await writeFile(
    paths.lockPath,
    JSON.stringify({ pid: child.pid, processStartedAt: Date.now() }),
    'utf8',
  );

  try {
    await assert.rejects(
      () => openSessionStoreV2(root, { maxMessages: 0 }),
      /already in use by process/i,
    );
  } finally {
    child.kill();
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  }

  const reopened = await openSessionStoreV2(root, { maxMessages: 0 });
  const lock = JSON.parse(await readFile(paths.lockPath, 'utf8')) as { pid?: number };
  assert.ok(reopened);
  assert.equal(lock.pid, process.pid);
});
