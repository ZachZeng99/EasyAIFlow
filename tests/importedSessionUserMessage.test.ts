import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const run = async (name: string, fn: () => Promise<void>) => {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

await run('createProject imports native user text blocks and skips synthetic no-response placeholders', async () => {
  const tempRoot = path.join(process.cwd(), '.tmp-tests', 'imported-session-user-message');
  await rm(tempRoot, { recursive: true, force: true });

  const appDataRoot = path.join(tempRoot, 'AppData', 'Roaming');
  const userProfile = path.join(tempRoot, 'UserProfile');
  process.env.APPDATA = appDataRoot;
  process.env.USERPROFILE = userProfile;
  process.env.HOME = userProfile;

  const rootPath = 'X:\\AITool\\EasyAIFlow\\.tmp-tests\\ImportedUserProject';
  const sessionId = 'native-user-message';
  const prompt = '你觉得我的优化思路还有没有需要优化的地方？';
  const reply = '几个补充建议：';

  const { toClaudeProjectDirName } = await import('../electron/workspacePaths.ts');
  const dirName = toClaudeProjectDirName(rootPath);
  assert.ok(dirName);

  const nativeDir = path.join(userProfile, '.claude', 'projects', dirName);
  await mkdir(nativeDir, { recursive: true });
  await writeFile(
    path.join(nativeDir, `${sessionId}.jsonl`),
    [
      {
        type: 'custom-title',
        customTitle: 'Shader',
        sessionId,
      },
      {
        type: 'assistant',
        timestamp: '2026-03-26T08:23:53.091Z',
        cwd: rootPath,
        sessionId,
        message: {
          model: '<synthetic>',
          content: [{ type: 'text', text: 'No response requested.' }],
        },
      },
      {
        type: 'user',
        timestamp: '2026-03-26T08:23:53.144Z',
        cwd: rootPath,
        sessionId,
        message: {
          role: 'user',
          content: [{ type: 'text', text: prompt }],
        },
      },
      {
        type: 'assistant',
        timestamp: '2026-03-26T08:25:00.567Z',
        cwd: rootPath,
        sessionId,
        message: {
          model: 'claude-opus-4-6',
          content: [{ type: 'text', text: reply }],
        },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join('\n')
      .concat('\n'),
    'utf8',
  );

  const { createProject } = await import('../electron/sessionStore.ts');
  const result = await createProject('Imported User Project', rootPath);
  const messages = result.session.messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));

  assert.deepEqual(messages, [
    {
      role: 'user',
      content: prompt,
    },
    {
      role: 'assistant',
      content: reply,
    },
  ]);
});

await run('createProject ignores background task cleanup follow-ups after queue notifications', async () => {
  const tempRoot = path.join(process.cwd(), '.tmp-tests', 'imported-background-task-notification');
  await rm(tempRoot, { recursive: true, force: true });

  const appDataRoot = path.join(tempRoot, 'AppData', 'Roaming');
  const userProfile = path.join(tempRoot, 'UserProfile');
  process.env.APPDATA = appDataRoot;
  process.env.USERPROFILE = userProfile;
  process.env.HOME = userProfile;

  const rootPath = 'X:\\AITool\\EasyAIFlow\\.tmp-tests\\ImportedBackgroundTaskProject';
  const sessionId = 'native-background-task';
  const prompt = '哪里有设置或者选项说明ps5的float有half精度的';
  const reply = '真正的最终回答';
  const backgroundCleanup = '后台任务清理完了。需要我帮你做什么就说。';

  const { toClaudeProjectDirName } = await import('../electron/workspacePaths.ts');
  const dirName = toClaudeProjectDirName(rootPath);
  assert.ok(dirName);

  const nativeDir = path.join(userProfile, '.claude', 'projects', dirName);
  await mkdir(nativeDir, { recursive: true });
  await writeFile(
    path.join(nativeDir, `${sessionId}.jsonl`),
    [
      {
        type: 'custom-title',
        customTitle: 'Shader',
        sessionId,
      },
      {
        type: 'user',
        timestamp: '2026-03-27T10:47:00.000Z',
        cwd: rootPath,
        sessionId,
        message: {
          role: 'user',
          content: [{ type: 'text', text: prompt }],
        },
      },
      {
        type: 'assistant',
        timestamp: '2026-03-27T10:59:58.483Z',
        cwd: rootPath,
        sessionId,
        message: {
          model: 'claude-opus-4-6',
          content: [{ type: 'text', text: reply }],
        },
      },
      {
        type: 'queue-operation',
        operation: 'enqueue',
        timestamp: '2026-03-27T10:59:58.536Z',
        sessionId,
        content:
          '<task-notification>\n<task-id>b032kya7w</task-id>\n<status>completed</status>\n</task-notification>',
      },
      {
        type: 'assistant',
        timestamp: '2026-03-27T11:00:09.447Z',
        cwd: rootPath,
        sessionId,
        message: {
          model: 'claude-opus-4-6',
          content: [{ type: 'text', text: backgroundCleanup }],
        },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join('\n')
      .concat('\n'),
    'utf8',
  );

  const { createProject } = await import('../electron/sessionStore.ts');
  const result = await createProject('Imported Background Task Project', rootPath);
  const messages = result.session.messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));

  assert.deepEqual(messages, [
    {
      role: 'user',
      content: prompt,
    },
    {
      role: 'assistant',
      content: reply,
    },
  ]);
});

await run('createProject skips native Claude local-command sessions that contain no real conversation messages', async () => {
  const tempRoot = path.join(process.cwd(), '.tmp-tests', 'imported-local-command-session');
  await rm(tempRoot, { recursive: true, force: true });

  const appDataRoot = path.join(tempRoot, 'AppData', 'Roaming');
  const userProfile = path.join(tempRoot, 'UserProfile');
  process.env.APPDATA = appDataRoot;
  process.env.USERPROFILE = userProfile;
  process.env.HOME = userProfile;

  const rootPath = 'X:\\AITool\\EasyAIFlow\\.tmp-tests\\ImportedCommandOnlyProject';
  const sessionId = 'native-local-command-only';

  const { toClaudeProjectDirName } = await import('../electron/workspacePaths.ts');
  const dirName = toClaudeProjectDirName(rootPath);
  assert.ok(dirName);

  const nativeDir = path.join(userProfile, '.claude', 'projects', dirName);
  await mkdir(nativeDir, { recursive: true });
  await writeFile(
    path.join(nativeDir, `${sessionId}.jsonl`),
    [
      {
        type: 'user',
        timestamp: '2026-03-26T08:23:53.144Z',
        cwd: rootPath,
        sessionId,
        message: {
          role: 'user',
          content: '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>',
        },
      },
      {
        type: 'user',
        timestamp: '2026-03-26T08:23:53.200Z',
        cwd: rootPath,
        sessionId,
        message: {
          role: 'user',
          content: '<local-command-stdout>Set model to Opus 4.7</local-command-stdout>',
        },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join('\n')
      .concat('\n'),
    'utf8',
  );

  const { createProject } = await import('../electron/sessionStore.ts');
  const result = await createProject('Imported Command Project', rootPath);
  const importedTitles = result.projects[0]?.dreams[0]?.sessions.map((session) => session.title) ?? [];

  assert.equal(importedTitles.includes(`Imported ${sessionId.slice(0, 8)}`), false);
});
