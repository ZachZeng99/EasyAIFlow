import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
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

await run('createProject imports Codex CLI sessions under the opened project tree into Temporary', async () => {
  const tempBase = path.resolve('.tmp-tests');
  await mkdir(tempBase, { recursive: true });
  const tempRoot = await mkdtemp(path.join(tempBase, 'session-store-codex-import-'));
  const userDataPath = path.join(tempRoot, 'userData');
  const homePath = path.join(tempRoot, 'home');
  const projectRoot = path.join(tempRoot, 'PBZ');
  const childWorkspace = path.join(projectRoot, 'ProjectPBZ');
  const codexSessionsDir = path.join(homePath, '.codex', 'sessions', '2026', '04', '06');
  const codexIndexPath = path.join(homePath, '.codex', 'session_index.jsonl');

  await mkdir(userDataPath, { recursive: true });
  await mkdir(childWorkspace, { recursive: true });
  await mkdir(codexSessionsDir, { recursive: true });
  await mkdir(path.dirname(codexIndexPath), { recursive: true });

  await writeFile(
    codexIndexPath,
    `${JSON.stringify({
      id: 'imported-thread',
      thread_name: 'PBZ Codex imported thread',
      updated_at: '2026-04-06T12:00:05.000Z',
    })}\n`,
    'utf8',
  );

  await writeFile(
    path.join(codexSessionsDir, 'rollout-2026-04-06T12-00-00-imported-thread.jsonl'),
    [
      JSON.stringify({
        timestamp: '2026-04-06T12:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'imported-thread',
          cwd: childWorkspace,
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-06T12:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '# AGENTS.md instructions for D:\\PBZ\n\n<INSTRUCTIONS>\nlegacy prompt\n</INSTRUCTIONS>' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-06T12:00:01.500Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Understood. I will avoid claiming manual approval or other UI actions unless you explicitly state them.' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-06T12:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '检查 PBZ 的旧线程导入' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-06T12:00:02.500Z',
        type: 'turn_context',
        payload: {
          cwd: childWorkspace,
          model: 'gpt-5.4',
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-06T12:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '已记录，后续继续处理。' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-06T12:00:04.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 12,
              cached_input_tokens: 3,
              output_tokens: 5,
            },
            model_context_window: 272000,
          },
        },
      }),
      '',
    ].join('\n'),
    'utf8',
  );

  const previousUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = homePath;
  configureRuntimePaths({ mode: 'web', userDataPath, homePath });

  try {
    const sessionStore = await importFreshSessionStore();
    const result = await sessionStore.createProject('PBZ', projectRoot);
    const temporary = result.projects[0]?.dreams.find((dream: { isTemporary?: boolean }) => dream.isTemporary);
    const imported = temporary?.sessions.find(
      (session: { codexThreadId?: string }) => session.codexThreadId === 'imported-thread',
    ) as
      | {
          provider?: string;
          workspace?: string;
          dreamName?: string;
          title?: string;
          preview?: string;
          tokenUsage?: { used?: number };
          messages?: Array<{ role?: string; content?: string }>;
        }
      | undefined;

    assert.equal(imported?.provider, 'codex');
    assert.equal(imported?.workspace, childWorkspace);
    assert.equal(imported?.dreamName, 'Temporary');
    assert.equal(imported?.title, 'PBZ Codex imported thread');
    assert.equal(imported?.preview, '已记录，后续继续处理。');
    assert.equal(imported?.tokenUsage?.used, 20);
    assert.deepEqual(
      imported?.messages?.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      [
        { role: 'user', content: '检查 PBZ 的旧线程导入' },
        { role: 'assistant', content: '已记录，后续继续处理。' },
      ],
    );
  } finally {
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
  }
});

await run('renameEntity persists Codex thread titles and keeps them after reload', async () => {
  const tempBase = path.resolve('.tmp-tests');
  await mkdir(tempBase, { recursive: true });
  const tempRoot = await mkdtemp(path.join(tempBase, 'session-store-codex-rename-'));
  const userDataPath = path.join(tempRoot, 'userData');
  const homePath = path.join(tempRoot, 'home');
  const projectRoot = path.join(tempRoot, 'PBZ');
  const childWorkspace = path.join(projectRoot, 'ProjectPBZ');
  const codexSessionsDir = path.join(homePath, '.codex', 'sessions', '2026', '04', '06');
  const codexIndexPath = path.join(homePath, '.codex', 'session_index.jsonl');

  await mkdir(userDataPath, { recursive: true });
  await mkdir(childWorkspace, { recursive: true });
  await mkdir(codexSessionsDir, { recursive: true });
  await mkdir(path.dirname(codexIndexPath), { recursive: true });

  await writeFile(
    codexIndexPath,
    `${JSON.stringify({
      id: 'rename-thread',
      thread_name: 'Original Codex title',
      updated_at: '2026-04-06T12:00:05.000Z',
    })}\n`,
    'utf8',
  );

  await writeFile(
    path.join(codexSessionsDir, 'rollout-2026-04-06T12-00-00-rename-thread.jsonl'),
    [
      JSON.stringify({
        timestamp: '2026-04-06T12:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'rename-thread',
          cwd: childWorkspace,
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-06T12:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '把导入标题改掉' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-06T12:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '已收到。' }],
        },
      }),
      '',
    ].join('\n'),
    'utf8',
  );

  const previousUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = homePath;
  configureRuntimePaths({ mode: 'web', userDataPath, homePath });

  try {
    const sessionStore = await importFreshSessionStore();
    const created = await sessionStore.createProject('PBZ', projectRoot);
    const temporary = created.projects[0]?.dreams.find((dream: { isTemporary?: boolean }) => dream.isTemporary);
    const imported = temporary?.sessions.find(
      (session: { codexThreadId?: string }) => session.codexThreadId === 'rename-thread',
    ) as { id: string; title?: string } | undefined;

    assert.equal(imported?.title, 'Original Codex title');

    await sessionStore.renameEntity('session', imported!.id, 'Renamed in EasyAIFlow');
    await sessionStore.flushPendingSave();

    const updatedIndex = await readFile(codexIndexPath, 'utf8');
    assert.match(updatedIndex, /"id":"rename-thread"/);
    assert.match(updatedIndex, /"thread_name":"Renamed in EasyAIFlow"/);

    const reloadedStore = await importFreshSessionStore();
    const projects = await reloadedStore.getProjects();
    const reloadedTemporary = projects[0]?.dreams.find((dream: { isTemporary?: boolean }) => dream.isTemporary);
    const reloaded = reloadedTemporary?.sessions.find(
      (session: { codexThreadId?: string }) => session.codexThreadId === 'rename-thread',
    ) as { title?: string } | undefined;

    assert.equal(reloaded?.title, 'Renamed in EasyAIFlow');
  } finally {
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
  }
});
