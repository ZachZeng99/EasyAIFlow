import assert from 'node:assert/strict';
import { appendFile, mkdtemp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { configureRuntimePaths } from '../backend/runtimePaths.ts';
import type { ConversationMessage, SessionRecord } from '../src/data/types.ts';
import { getSessionStoreV2Paths } from '../electron/sessionStoreV2.ts';

const run = async (name: string, fn: () => Promise<void>) => {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

const importFreshSessionStore = async () =>
  import(`${pathToFileURL(path.resolve('electron/sessionStore.ts')).href}?t=${Date.now()}-${Math.random()}`);

const message = (id: string): ConversationMessage => ({
  id,
  role: 'assistant',
  timestamp: 'Just now',
  title: id,
  content: id,
  status: 'complete',
});

const session = (id: string, messages: ConversationMessage[]): SessionRecord => ({
  id,
  title: id,
  preview: messages.at(-1)?.content ?? '',
  timeLabel: 'Just now',
  updatedAt: 1,
  provider: 'codex',
  model: 'gpt-5',
  workspace: 'X:\\workspace',
  projectId: 'project-1',
  projectName: 'Project',
  dreamId: 'dream-1',
  dreamName: 'Dream',
  codexThreadId: `thread-${id}`,
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

await run('auto-migrates V1 and subsequent updates touch only the active V2 session', async () => {
  const base = path.resolve('.tmp-tests');
  await mkdir(base, { recursive: true });
  const tempRoot = await mkdtemp(path.join(base, 'session-store-v2-integration-'));
  const userDataPath = path.join(tempRoot, 'userData');
  const homePath = path.join(tempRoot, 'home');
  const legacyPath = path.join(userDataPath, 'easyaiflow-sessions.json');
  const first = session(
    'session-1',
    Array.from({ length: 250 }, (_, index) => message(`first-${index}`)),
  );
  const second = session('session-2', [message('unrelated')]);
  const legacyState = {
    projects: [
      {
        id: 'project-1',
        name: 'Project',
        rootPath: 'X:\\workspace',
        dreams: [
          {
            id: 'dream-1',
            name: 'Dream',
            sessions: [first, second],
          },
        ],
      },
    ],
    deletedImports: {
      claudeSessionIds: [],
      codexThreadIds: [],
    },
  };
  const legacyBytes = `${JSON.stringify(legacyState, null, 2)}\n`;
  await mkdir(userDataPath, { recursive: true });
  await mkdir(path.join(homePath, '.claude', 'projects'), { recursive: true });
  await writeFile(legacyPath, legacyBytes, 'utf8');

  const previousUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = homePath;
  configureRuntimePaths({ mode: 'web', userDataPath, homePath });
  let store: Awaited<ReturnType<typeof importFreshSessionStore>> | undefined;

  try {
    store = await importFreshSessionStore();
    await store.getProjectsForBootstrap();
    await store.flushPendingSave();

    const unrelatedPaths = getSessionStoreV2Paths(userDataPath, second.id);
    const unrelatedBefore = await stat(unrelatedPaths.metaPath);
    await store.appendMessagesToSession(first.id, [message('second')], 'second', 'Just now');
    await store.flushPendingSave();
    const unrelatedAfter = await stat(unrelatedPaths.metaPath);

    const reloadedStore = await importFreshSessionStore();
    const catalog = await reloadedStore.getProjectsForBootstrap();
    const reloaded = await reloadedStore.getSessionRecordForBootstrap(first.id);
    const older = reloaded?.historyPage?.nextBefore
      ? await reloadedStore.getSessionMessagePage(first.id, reloaded.historyPage.nextBefore)
      : null;
    const materialized = await reloadedStore.materializeSessionHistoryForRuntime(first.id);
    const materializedMessageCount = materialized?.messages.length;
    const released = await reloadedStore.releaseMaterializedSessionHistory(first.id);
    const releasedRecord = await reloadedStore.findSession(first.id);
    await reloadedStore.flushPendingSave();
    const userDataEntries = await readdir(userDataPath);

    assert.equal(await readFile(legacyPath, 'utf8'), legacyBytes);
    assert.equal(unrelatedAfter.mtimeMs, unrelatedBefore.mtimeMs);
    const catalogSession = catalog[0]?.dreams[0]?.sessions.find((item) => item.id === first.id);
    assert.deepEqual((catalogSession as SessionRecord | undefined)?.messages, []);
    assert.equal(catalogSession?.messagesLoaded, false);
    assert.equal(reloaded?.messages.length, 51);
    assert.equal(reloaded?.messages[0]?.id, 'first-200');
    assert.equal(reloaded?.messages.at(-1)?.id, 'second');
    assert.equal(reloaded?.historyPage?.hasMoreBefore, true);
    assert.equal(older?.messages.length, 100);
    assert.equal(older?.messages[0]?.id, 'first-100');
    assert.equal(older?.messages.at(-1)?.id, 'first-199');
    assert.equal(materializedMessageCount, 251);
    assert.equal(released, true);
    assert.deepEqual(releasedRecord?.messages, []);
    assert.equal(releasedRecord?.messagesLoaded, false);
    assert.equal(
      userDataEntries.some(
        (entry) => entry.startsWith('easyaiflow-sessions.json.') && entry.endsWith('.tmp'),
      ),
      false,
    );
  } finally {
    await store?.flushPendingSave();
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
  }
});

await run('does not silently fall back to stale V1 after an activated V2 store is corrupted', async () => {
  const base = path.resolve('.tmp-tests');
  await mkdir(base, { recursive: true });
  const tempRoot = await mkdtemp(path.join(base, 'session-store-v2-no-stale-fallback-'));
  const userDataPath = path.join(tempRoot, 'userData');
  const homePath = path.join(tempRoot, 'home');
  const legacyPath = path.join(userDataPath, 'easyaiflow-sessions.json');
  const target = session('session-1', [message('legacy')]);
  const legacyState = {
    projects: [
      {
        id: 'project-1',
        name: 'Project',
        rootPath: 'X:\\workspace',
        dreams: [{ id: 'dream-1', name: 'Dream', sessions: [target] }],
      },
    ],
    deletedImports: { claudeSessionIds: [], codexThreadIds: [] },
  };
  await mkdir(userDataPath, { recursive: true });
  await mkdir(path.join(homePath, '.claude', 'projects'), { recursive: true });
  await writeFile(legacyPath, JSON.stringify(legacyState), 'utf8');

  const previousUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = homePath;
  configureRuntimePaths({ mode: 'web', userDataPath, homePath });

  try {
    const initialStore = await importFreshSessionStore();
    await initialStore.getProjectsForBootstrap();
    await initialStore.flushPendingSave();
    const eventsPath = getSessionStoreV2Paths(userDataPath, target.id).eventsPath;
    await appendFile(eventsPath, '{broken}\n{"also":"broken"}\n', 'utf8');

    const reloadedStore = await importFreshSessionStore();
    const projects = await reloadedStore.getProjectsForBootstrap();
    assert.equal(projects[0]?.dreams[0]?.sessions[0]?.id, target.id);
    await assert.rejects(
      () => reloadedStore.getSessionRecordForBootstrap(target.id),
      /malformed session event log/i,
    );
  } finally {
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
  }
});

await run('recovers stale pending messages lazily when a session is first opened after restart', async () => {
  const base = path.resolve('.tmp-tests');
  await mkdir(base, { recursive: true });
  const tempRoot = await mkdtemp(path.join(base, 'session-store-v2-lazy-recovery-'));
  const userDataPath = path.join(tempRoot, 'userData');
  const homePath = path.join(tempRoot, 'home');
  const legacyPath = path.join(userDataPath, 'easyaiflow-sessions.json');
  const target = session('session-pending', [{ ...message('pending'), status: 'queued', content: '' }]);
  await mkdir(userDataPath, { recursive: true });
  await mkdir(path.join(homePath, '.claude', 'projects'), { recursive: true });
  await writeFile(legacyPath, JSON.stringify({
    projects: [{
      id: 'project-1',
      name: 'Project',
      rootPath: 'X:\\workspace',
      dreams: [{ id: 'dream-1', name: 'Dream', sessions: [target] }],
    }],
    deletedImports: { claudeSessionIds: [], codexThreadIds: [] },
  }), 'utf8');

  const previousUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = homePath;
  configureRuntimePaths({ mode: 'web', userDataPath, homePath });
  try {
    const store = await importFreshSessionStore();
    const catalog = await store.getProjectsForBootstrap();
    assert.deepEqual((catalog[0]?.dreams[0]?.sessions[0] as SessionRecord).messages, []);
    const opened = await store.getSessionRecordForBootstrap(target.id);
    assert.equal(opened?.messages[0]?.status, 'error');
    assert.equal(opened?.messages[0]?.content, 'Queued Codex run did not resume after restart.');
    await store.flushPendingSave();

    const reloaded = await importFreshSessionStore();
    const persisted = await reloaded.getSessionRecordForBootstrap(target.id);
    assert.equal(persisted?.messages[0]?.status, 'error');
    assert.equal(persisted?.messages[0]?.content, 'Queued Codex run did not resume after restart.');
  } finally {
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
  }
});

await run('bounds trace content for UI pages without changing runtime materialization', async () => {
  const base = path.resolve('.tmp-tests');
  await mkdir(base, { recursive: true });
  const tempRoot = await mkdtemp(path.join(base, 'session-store-v2-trace-safety-'));
  const userDataPath = path.join(tempRoot, 'userData');
  const homePath = path.join(tempRoot, 'home');
  const legacyPath = path.join(userDataPath, 'easyaiflow-sessions.json');
  const rawTraceContent = JSON.stringify({
    image_url: `data:image/png;base64,${'A'.repeat(300_000)}`,
  });
  const trace: ConversationMessage = {
    ...message('trace-image'),
    role: 'system',
    kind: 'tool_use',
    title: 'exec',
    content: rawTraceContent,
    status: 'success',
  };
  const target = session('session-trace-safety', [
    trace,
    ...Array.from({ length: 100 }, (_, index) => message(`normal-${index}`)),
  ]);
  await mkdir(userDataPath, { recursive: true });
  await mkdir(path.join(homePath, '.claude', 'projects'), { recursive: true });
  await writeFile(legacyPath, JSON.stringify({
    projects: [{
      id: 'project-1',
      name: 'Project',
      rootPath: 'X:\\workspace',
      dreams: [{ id: 'dream-1', name: 'Dream', sessions: [target] }],
    }],
    deletedImports: { claudeSessionIds: [], codexThreadIds: [] },
  }), 'utf8');

  const previousUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = homePath;
  configureRuntimePaths({ mode: 'web', userDataPath, homePath });
  let store: Awaited<ReturnType<typeof importFreshSessionStore>> | undefined;

  try {
    store = await importFreshSessionStore();
    await store.getProjectsForBootstrap();
    const opened = await store.getSessionRecordForBootstrap(target.id);
    assert.equal(opened?.messages.length, 1);
    assert.equal(opened?.historyPage?.hasMoreBefore, true);

    const older = opened?.historyPage?.nextBefore
      ? await store.getSessionMessagePage(target.id, opened.historyPage.nextBefore)
      : null;
    const displayedTrace = older?.messages.find((entry) => entry.id === trace.id);
    assert.ok(displayedTrace);
    assert.equal(displayedTrace.content.includes('data:image'), false);
    assert.match(displayedTrace.content, /Embedded binary data omitted/);
    assert.ok(displayedTrace.content.length < 1024);

    const materialized = await store.materializeSessionHistoryForRuntime(target.id);
    const runtimeTrace = materialized?.messages.find((entry) => entry.id === trace.id);
    assert.equal(runtimeTrace?.content, rawTraceContent);
  } finally {
    await store?.flushPendingSave();
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
  }
});
