import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { configureRuntimePaths } from '../backend/runtimePaths.ts';

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

await run('createSessionInStreamwork returns a lightweight project snapshot', async () => {
  const tempBase = path.resolve('.tmp-tests');
  await mkdir(tempBase, { recursive: true });
  const tempRoot = await mkdtemp(path.join(tempBase, 'session-store-create-session-'));
  const userDataPath = path.join(tempRoot, 'userData');
  const homePath = path.join(tempRoot, 'home');
  const projectRoot = path.join(tempRoot, 'workspace');

  await mkdir(userDataPath, { recursive: true });
  await mkdir(homePath, { recursive: true });
  await mkdir(projectRoot, { recursive: true });

  const previousUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = homePath;
  configureRuntimePaths({ mode: 'web', userDataPath, homePath });
  let sessionStore: Awaited<ReturnType<typeof importFreshSessionStore>> | undefined;

  try {
    sessionStore = await importFreshSessionStore();
    const projectResult = await sessionStore.createProject('Smoke', projectRoot);

    await sessionStore.updateSessionRecord(projectResult.session.id, (session: {
      messages: Array<Record<string, unknown>>;
    }) => {
      session.messages.push({
        id: 'existing-message',
        role: 'assistant',
        timestamp: '4/25 10:00',
        title: 'Existing reply',
        content: 'large persisted history',
        status: 'complete',
      });
    });

    const created = await sessionStore.createSessionInStreamwork(
      projectResult.session.dreamId,
      'Followup',
      false,
      'codex',
      'standard',
    );

    const persistedSource = await sessionStore.findSession(projectResult.session.id);
    const sourceSnapshot = created.projects[0]?.dreams
      .flatMap((dream: { sessions: Array<{ id: string }> }) => dream.sessions)
      .find((session: { id: string }) => session.id === projectResult.session.id) as
      | { messages?: unknown[]; messagesLoaded?: boolean }
      | undefined;

    assert.equal(persistedSource?.messages.length, 1);
    assert.equal(sourceSnapshot?.messages?.length, 0);
    assert.equal(sourceSnapshot?.messagesLoaded, false);
    assert.equal(created.session.title, 'Followup');
    assert.deepEqual(created.session.messages, []);
  } finally {
    await sessionStore?.flushPendingSave();
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
  }
});

await run('createSession returns a lightweight project snapshot', async () => {
  const tempBase = path.resolve('.tmp-tests');
  await mkdir(tempBase, { recursive: true });
  const tempRoot = await mkdtemp(path.join(tempBase, 'session-store-create-session-source-'));
  const userDataPath = path.join(tempRoot, 'userData');
  const homePath = path.join(tempRoot, 'home');
  const projectRoot = path.join(tempRoot, 'workspace');

  await mkdir(userDataPath, { recursive: true });
  await mkdir(homePath, { recursive: true });
  await mkdir(projectRoot, { recursive: true });

  const previousUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = homePath;
  configureRuntimePaths({ mode: 'web', userDataPath, homePath });
  let sessionStore: Awaited<ReturnType<typeof importFreshSessionStore>> | undefined;

  try {
    sessionStore = await importFreshSessionStore();
    const projectResult = await sessionStore.createProject('Smoke', projectRoot);

    await sessionStore.updateSessionRecord(projectResult.session.id, (session: {
      messages: Array<Record<string, unknown>>;
    }) => {
      session.messages.push({
        id: 'existing-message',
        role: 'assistant',
        timestamp: '4/25 10:00',
        title: 'Existing reply',
        content: 'large persisted history',
        status: 'complete',
      });
    });

    const created = await sessionStore.createSession(projectResult.session.id, false, 'codex');
    const sourceSnapshot = created.projects[0]?.dreams
      .flatMap((dream: { sessions: Array<{ id: string }> }) => dream.sessions)
      .find((session: { id: string }) => session.id === projectResult.session.id) as
      | { messages?: unknown[]; messagesLoaded?: boolean }
      | undefined;

    assert.equal(sourceSnapshot?.messages?.length, 0);
    assert.equal(sourceSnapshot?.messagesLoaded, false);
    assert.equal(created.session.provider, 'codex');
    assert.deepEqual(created.session.messages, []);
  } finally {
    await sessionStore?.flushPendingSave();
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
  }
});
