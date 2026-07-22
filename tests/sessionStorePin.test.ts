import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { configureRuntimePaths } from '../backend/runtimePaths.ts';
import { toClaudeProjectDirName } from '../electron/workspacePaths.ts';

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

await run('setSessionPinned persists pin state without changing session recency', async () => {
  const tempBase = path.resolve('.tmp-tests');
  await mkdir(tempBase, { recursive: true });
  const tempRoot = await mkdtemp(path.join(tempBase, 'session-store-pin-'));
  const userDataPath = path.join(tempRoot, 'userData');
  const homePath = path.join(tempRoot, 'home');
  const projectRoot = path.join(tempRoot, 'workspace');

  await mkdir(userDataPath, { recursive: true });
  await mkdir(homePath, { recursive: true });
  await mkdir(projectRoot, { recursive: true });

  const previousUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = homePath;
  configureRuntimePaths({ mode: 'web', userDataPath, homePath });

  try {
    const store = await importFreshSessionStore();
    const created = await store.createProject('Pinned project', projectRoot);
    const updatedAt = created.session.updatedAt;

    const pinned = await store.setSessionPinned(created.session.id, true);
    const pinnedSummary = pinned.projects[0]?.dreams
      .flatMap((dream) => dream.sessions)
      .find((session) => session.id === created.session.id);

    assert.equal(pinnedSummary?.pinned, true);
    assert.equal(pinnedSummary?.updatedAt, updatedAt);
    assert.equal((await store.findSession(created.session.id))?.pinned, true);

    await store.flushPendingSave();
    const reloadedStore = await importFreshSessionStore();
    const reloadedProjects = await reloadedStore.getProjectsForBootstrap();
    const reloadedSession = reloadedProjects[0]?.dreams
      .flatMap((dream) => dream.sessions)
      .find((session) => session.id === created.session.id);

    assert.equal(reloadedSession?.pinned, true);

    const unpinned = await reloadedStore.setSessionPinned(created.session.id, false);
    const unpinnedSummary = unpinned.projects[0]?.dreams
      .flatMap((dream) => dream.sessions)
      .find((session) => session.id === created.session.id);

    assert.equal(unpinnedSummary?.pinned, false);
    assert.equal(unpinnedSummary?.updatedAt, updatedAt);
    await reloadedStore.flushPendingSave();
  } finally {
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
  }
});

await run('native history refresh preserves a pinned EasyAIFlow session', async () => {
  const tempBase = path.resolve('.tmp-tests');
  await mkdir(tempBase, { recursive: true });
  const tempRoot = await mkdtemp(path.join(tempBase, 'session-store-pin-native-refresh-'));
  const userDataPath = path.join(tempRoot, 'userData');
  const homePath = path.join(tempRoot, 'home');
  const projectRoot = path.join(tempRoot, 'workspace');
  const nativeSessionId = '2b11e80c-0305-4f20-8a5c-2b8bd7efe72b';
  const nativeDirName = toClaudeProjectDirName(projectRoot);
  assert.ok(nativeDirName);
  const nativeSessionPath = path.join(
    homePath,
    '.claude',
    'projects',
    nativeDirName,
    `${nativeSessionId}.jsonl`,
  );

  await mkdir(userDataPath, { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  await mkdir(path.dirname(nativeSessionPath), { recursive: true });

  const previousUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = homePath;
  configureRuntimePaths({ mode: 'web', userDataPath, homePath });

  try {
    const store = await importFreshSessionStore();
    const created = await store.createProject('Pinned native project', projectRoot);
    await store.setSessionRuntime(created.session.id, { claudeSessionId: nativeSessionId });
    await store.setSessionPinned(created.session.id, true);
    await writeFile(
      nativeSessionPath,
      [
        JSON.stringify({
          type: 'custom-title',
          customTitle: created.session.title,
          sessionId: nativeSessionId,
        }),
        JSON.stringify({
          type: 'user',
          timestamp: '2026-07-22T08:00:00.000Z',
          cwd: projectRoot,
          sessionId: nativeSessionId,
          message: { role: 'user', content: 'Keep this thread pinned.' },
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-07-22T08:00:01.000Z',
          cwd: projectRoot,
          sessionId: nativeSessionId,
          message: {
            model: 'claude-opus-4-8',
            role: 'assistant',
            content: [{ type: 'text', text: 'Pinned.' }],
          },
        }),
        '',
      ].join('\n'),
      'utf8',
    );

    const refreshedProjects = await store.getProjectsForBootstrap();
    const refreshedSession = refreshedProjects[0]?.dreams
      .flatMap((dream) => dream.sessions)
      .find((session) => session.id === created.session.id);

    assert.equal(refreshedSession?.pinned, true);
    await store.flushPendingSave();
  } finally {
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
  }
});

await run('setSessionPinned rejects unknown sessions', async () => {
  const tempBase = path.resolve('.tmp-tests');
  await mkdir(tempBase, { recursive: true });
  const tempRoot = await mkdtemp(path.join(tempBase, 'session-store-pin-missing-'));
  const userDataPath = path.join(tempRoot, 'userData');
  const homePath = path.join(tempRoot, 'home');

  await mkdir(userDataPath, { recursive: true });
  await mkdir(homePath, { recursive: true });

  const previousUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = homePath;
  configureRuntimePaths({ mode: 'web', userDataPath, homePath });

  try {
    const store = await importFreshSessionStore();
    await assert.rejects(() => store.setSessionPinned('missing-session', true), /Session not found\./);
    await store.flushPendingSave();
  } finally {
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
  }
});
