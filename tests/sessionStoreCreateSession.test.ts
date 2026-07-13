import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
  const nestedWorkspace = path.join(projectRoot, 'Engine', 'Source');

  await mkdir(userDataPath, { recursive: true });
  await mkdir(homePath, { recursive: true });
  await mkdir(nestedWorkspace, { recursive: true });

  const previousUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = homePath;
  configureRuntimePaths({ mode: 'web', userDataPath, homePath });
  let sessionStore: Awaited<ReturnType<typeof importFreshSessionStore>> | undefined;

  try {
    sessionStore = await importFreshSessionStore();
    const projectResult = await sessionStore.createProject('Smoke', projectRoot);

    await sessionStore.updateSessionRecord(projectResult.session.id, (session: {
      workspace: string;
      messages: Array<Record<string, unknown>>;
    }) => {
      session.workspace = nestedWorkspace;
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
    assert.equal(created.session.workspace, projectRoot);
    assert.deepEqual(created.session.messages, []);

    const groupCreated = await sessionStore.createSession(
      projectResult.session.id,
      false,
      undefined,
      'group',
    );
    assert.equal(groupCreated.session.workspace, projectRoot);
    assert.equal(groupCreated.session.group?.kind, 'room');
    for (const participant of groupCreated.session.group?.participants ?? []) {
      const backing = await sessionStore.findSession(participant.backingSessionId);
      assert.equal(backing?.workspace, projectRoot);
    }
  } finally {
    await sessionStore?.flushPendingSave();
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
  }
});

await run('native refresh keeps an EasyAIFlow session anchored to the project root', async () => {
  const tempBase = path.resolve('.tmp-tests');
  await mkdir(tempBase, { recursive: true });
  const tempRoot = await mkdtemp(path.join(tempBase, 'session-store-refresh-workspace-'));
  const userDataPath = path.join(tempRoot, 'userData');
  const homePath = path.join(tempRoot, 'home');
  const projectRoot = path.join(tempRoot, 'workspace');
  const nestedWorkspace = path.join(projectRoot, 'Engine', 'Source');
  const nativeSessionId = '5b861bec-a52d-4564-88f7-2c2663d0380d';
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
  await mkdir(nestedWorkspace, { recursive: true });
  await mkdir(path.dirname(nativeSessionPath), { recursive: true });

  const previousUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = homePath;
  configureRuntimePaths({ mode: 'web', userDataPath, homePath });
  let sessionStore: Awaited<ReturnType<typeof importFreshSessionStore>> | undefined;

  try {
    sessionStore = await importFreshSessionStore();
    const projectResult = await sessionStore.createProject('Smoke', projectRoot);
    const created = await sessionStore.createSessionInStreamwork(
      projectResult.session.dreamId,
      'Anchored session',
      false,
      'claude',
      'standard',
    );
    await sessionStore.setSessionRuntime(created.session.id, {
      claudeSessionId: nativeSessionId,
    });

    await writeFile(
      nativeSessionPath,
      [
        JSON.stringify({
          type: 'custom-title',
          customTitle: 'Anchored session',
          sessionId: nativeSessionId,
        }),
        JSON.stringify({
          type: 'user',
          timestamp: '2026-07-13T08:00:00.000Z',
          cwd: nestedWorkspace,
          sessionId: nativeSessionId,
          message: { role: 'user', content: 'refresh this session' },
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-07-13T08:00:01.000Z',
          cwd: nestedWorkspace,
          sessionId: nativeSessionId,
          message: {
            model: 'claude-opus-4-8',
            role: 'assistant',
            content: [{ type: 'text', text: 'refreshed' }],
          },
        }),
        '',
      ].join('\n'),
      'utf8',
    );

    const projects = await sessionStore.getProjectsForBootstrap();
    const refreshed = projects[0]?.dreams
      .flatMap((dream) => dream.sessions)
      .find((session) => session.id === created.session.id);

    assert.equal(refreshed?.workspace, projectRoot);
  } finally {
    await sessionStore?.flushPendingSave();
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
  }
});

await run('setSessionRuntime records Claude sessions in native history for resume', async () => {
  const tempBase = path.resolve('.tmp-tests');
  await mkdir(tempBase, { recursive: true });
  const tempRoot = await mkdtemp(path.join(tempBase, 'session-store-claude-history-'));
  const userDataPath = path.join(tempRoot, 'userData');
  const homePath = path.join(tempRoot, 'home');
  const projectRoot = path.join(tempRoot, 'workspace');
  const historyPath = path.join(homePath, '.claude', 'history.jsonl');
  const nativeDirName = toClaudeProjectDirName(projectRoot);
  assert.ok(nativeDirName);
  const nativeSessionPath = path.join(
    homePath,
    '.claude',
    'projects',
    nativeDirName,
    '6dd52efd-fe53-4a87-86b9-28566fcb7b89.jsonl',
  );

  await mkdir(userDataPath, { recursive: true });
  await mkdir(homePath, { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  await mkdir(path.dirname(nativeSessionPath), { recursive: true });
  await writeFile(
    nativeSessionPath,
    [
      JSON.stringify({
        type: 'user',
        sessionId: '6dd52efd-fe53-4a87-86b9-28566fcb7b89',
        cwd: projectRoot,
        entrypoint: 'sdk-cli',
        promptSource: 'sdk',
        userType: 'external',
        message: {
          role: 'user',
          content: 'first prompt',
        },
      }),
      JSON.stringify({
        type: 'assistant',
        sessionId: '6dd52efd-fe53-4a87-86b9-28566fcb7b89',
        cwd: projectRoot,
        entrypoint: 'sdk-cli',
        userType: 'external',
        message: {
          model: 'claude-opus-4-8',
          role: 'assistant',
          content: [{ type: 'text', text: 'reply' }],
        },
      }),
    ].join('\n') + '\n',
    'utf8',
  );

  const previousUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = homePath;
  configureRuntimePaths({ mode: 'web', userDataPath, homePath });
  let sessionStore: Awaited<ReturnType<typeof importFreshSessionStore>> | undefined;

  try {
    sessionStore = await importFreshSessionStore();
    const projectResult = await sessionStore.createProject('Smoke', projectRoot);
    const created = await sessionStore.createSessionInStreamwork(
      projectResult.session.dreamId,
      'NaniteWPO',
      false,
      'claude',
      'standard',
    );

    await sessionStore.setSessionRuntime(created.session.id, {
      claudeSessionId: '6dd52efd-fe53-4a87-86b9-28566fcb7b89',
      model: 'opus[1m]',
    });
    await sessionStore.setSessionRuntime(created.session.id, {
      claudeSessionId: '6dd52efd-fe53-4a87-86b9-28566fcb7b89',
      model: 'opus[1m]',
      preview: 'latest answer',
    });

    const lines = (await readFile(historyPath, 'utf8')).trim().split(/\r?\n/);
    const entries = lines.map((line) => JSON.parse(line) as {
      display?: string;
      pastedContents?: unknown;
      timestamp?: unknown;
      project?: string;
      sessionId?: string;
    });
    const matching = entries.filter((entry) => entry.sessionId === '6dd52efd-fe53-4a87-86b9-28566fcb7b89');

    assert.equal(matching.length, 1);
    assert.equal(matching[0]?.display, 'NaniteWPO');
    assert.deepEqual(matching[0]?.pastedContents, {});
    assert.equal(matching[0]?.project, projectRoot);
    assert.equal(matching[0]?.sessionId, '6dd52efd-fe53-4a87-86b9-28566fcb7b89');
    assert.equal(typeof matching[0]?.timestamp, 'number');

    const nativeLines = (await readFile(nativeSessionPath, 'utf8')).trim().split(/\r?\n/);
    const nativeEntries = nativeLines.map((line) => JSON.parse(line) as {
      type?: string;
      aiTitle?: string;
      entrypoint?: string;
      promptSource?: string;
      sessionId?: string;
    });

    assert.ok(
      nativeEntries.some(
        (entry) =>
          entry.type === 'ai-title' &&
          entry.aiTitle === 'NaniteWPO' &&
          entry.sessionId === '6dd52efd-fe53-4a87-86b9-28566fcb7b89',
      ),
    );
    assert.equal(nativeEntries.some((entry) => entry.entrypoint === 'sdk-cli'), false);
    assert.equal(nativeEntries.some((entry) => entry.promptSource === 'sdk'), false);
    assert.ok(nativeEntries.some((entry) => entry.entrypoint === 'cli' && entry.promptSource === 'typed'));
  } finally {
    await sessionStore?.flushPendingSave();
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
  }
});

await run('backfillNativeClaudeResumeMetadata re-normalizes stale sdk-cli sessions', async () => {
  const tempBase = path.resolve('.tmp-tests');
  await mkdir(tempBase, { recursive: true });
  const tempRoot = await mkdtemp(path.join(tempBase, 'session-store-claude-backfill-'));
  const userDataPath = path.join(tempRoot, 'userData');
  const homePath = path.join(tempRoot, 'home');
  const projectRoot = path.join(tempRoot, 'workspace');
  const sessionId = '7ce91a02-1d3f-4f9a-9b21-0c4d5e6f7a8b';
  const nativeDirName = toClaudeProjectDirName(projectRoot);
  assert.ok(nativeDirName);
  const nativeSessionPath = path.join(
    homePath,
    '.claude',
    'projects',
    nativeDirName,
    `${sessionId}.jsonl`,
  );
  // A second copy of the same session left under a different project dir, as
  // happens when the session was first run under another cwd. Only reachable by
  // matching the session id (a UUID), not the recorded workspace.
  const orphanSessionPath = path.join(
    homePath,
    '.claude',
    'projects',
    `${nativeDirName}-OldCwd`,
    `${sessionId}.jsonl`,
  );

  const writeStaleSdkSessionTo = async (filePath: string) => {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      [
        JSON.stringify({
          type: 'user',
          sessionId,
          cwd: projectRoot,
          entrypoint: 'sdk-cli',
          promptSource: 'sdk',
          userType: 'external',
          message: { role: 'user', content: 'first prompt' },
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId,
          cwd: projectRoot,
          entrypoint: 'sdk-cli',
          userType: 'external',
          message: { model: 'claude-opus-4-8', role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
        }),
      ].join('\n') + '\n',
      'utf8',
    );
  };
  const writeStaleSdkSession = async () => {
    await writeStaleSdkSessionTo(nativeSessionPath);
    await writeStaleSdkSessionTo(orphanSessionPath);
  };

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
    const created = await sessionStore.createSessionInStreamwork(
      projectResult.session.dreamId,
      'VSM Clipmap',
      false,
      'claude',
      'standard',
    );
    await sessionStore.setSessionRuntime(created.session.id, {
      claudeSessionId: sessionId,
      model: 'opus[1m]',
    });

    // Older stored sessions leave `provider` undefined; the backfill must rescue
    // them off claudeSessionId alone, so strip it to mirror real data.
    await sessionStore.updateSessionRecord(created.session.id, (session: { provider?: unknown }) => {
      session.provider = undefined;
    });

    // Write the native log only now (after the store has loaded and imported),
    // so it represents a session created before the resume fix / left idle
    // across a restart, with the SDK markers /resume hides — and is not picked
    // up as a separate imported session.
    await writeStaleSdkSession();

    const state = await sessionStore.loadState();
    const result = await sessionStore.backfillNativeClaudeResumeMetadata(state);
    assert.ok(result.scanned >= 1);

    const nativeEntries = (await readFile(nativeSessionPath, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as {
        type?: string;
        aiTitle?: string;
        entrypoint?: string;
        promptSource?: string;
        sessionId?: string;
      });

    assert.equal(nativeEntries.some((entry) => entry.entrypoint === 'sdk-cli'), false);
    assert.equal(nativeEntries.some((entry) => entry.promptSource === 'sdk'), false);
    assert.ok(nativeEntries.some((entry) => entry.entrypoint === 'cli' && entry.promptSource === 'typed'));
    assert.ok(
      nativeEntries.some(
        (entry) =>
          entry.type === 'ai-title' && entry.aiTitle === 'VSM Clipmap' && entry.sessionId === sessionId,
      ),
    );

    // The orphan copy under the other project dir must be rescued too.
    const orphanEntries = (await readFile(orphanSessionPath, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { entrypoint?: string; promptSource?: string });
    assert.equal(orphanEntries.some((entry) => entry.entrypoint === 'sdk-cli'), false);
    assert.ok(orphanEntries.some((entry) => entry.entrypoint === 'cli' && entry.promptSource === 'typed'));
  } finally {
    await sessionStore?.flushPendingSave();
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
  }
});
