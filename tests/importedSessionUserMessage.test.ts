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
