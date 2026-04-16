import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
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

await run('deleteSession reports Claude native cleanup warnings when history cleanup fails', async () => {
  const tempRoot = path.join(process.cwd(), '.tmp-tests', 'session-store-delete-warning');
  await rm(tempRoot, { recursive: true, force: true });

  const userDataPath = path.join(tempRoot, 'userData');
  const homePath = path.join(tempRoot, 'home');
  const projectRoot = path.join(tempRoot, 'workspace');
  const claudeHistoryPath = path.join(homePath, '.claude', 'history.jsonl');
  const nativeDirName = toClaudeProjectDirName(projectRoot);
  const claudeSessionId = 'native-warning-session';

  assert.ok(nativeDirName);

  await mkdir(userDataPath, { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  await mkdir(path.join(homePath, '.claude', 'projects', nativeDirName), { recursive: true });
  await mkdir(claudeHistoryPath, { recursive: true });

  await writeFile(
    path.join(homePath, '.claude', 'projects', nativeDirName, `${claudeSessionId}.jsonl`),
    [
      {
        type: 'custom-title',
        customTitle: 'Claude import',
        sessionId: claudeSessionId,
      },
      {
        type: 'user',
        timestamp: '2026-04-16T10:00:00.000Z',
        cwd: projectRoot,
        sessionId: claudeSessionId,
        message: {
          role: 'user',
          content: [{ type: 'text', text: '删除后别再回来了' }],
        },
      },
      {
        type: 'assistant',
        timestamp: '2026-04-16T10:00:01.000Z',
        cwd: projectRoot,
        sessionId: claudeSessionId,
        message: {
          model: 'claude-opus-4-1',
          content: [{ type: 'text', text: '我会尝试清理原生历史。' }],
        },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join('\n')
      .concat('\n'),
    'utf8',
  );

  const previousUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = homePath;
  configureRuntimePaths({ mode: 'web', userDataPath, homePath });

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((value) => String(value)).join(' '));
  };

  try {
    const sessionStore = await importFreshSessionStore();
    const created = await sessionStore.createProject('Claude Warning Project', projectRoot);
    const temporary = created.projects[0]?.dreams.find((dream: { isTemporary?: boolean }) => dream.isTemporary);
    const imported = temporary?.sessions.find(
      (session: { claudeSessionId?: string }) => session.claudeSessionId === claudeSessionId,
    ) as { id: string } | undefined;

    assert.ok(imported);

    const result = await sessionStore.deleteSession(imported.id);

    assert.ok(result.deletedSessionIds.includes(imported.id));
    assert.equal(
      result.warning,
      'Deleted, but native session cleanup partially failed. Check the app logs for details.',
    );
    assert.ok(warnings.some((entry) => entry.includes('Failed to update native Claude history')));
    assert.ok(warnings.some((entry) => entry.includes('history.jsonl')));
  } finally {
    console.warn = originalWarn;
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
  }
});
