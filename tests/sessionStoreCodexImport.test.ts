import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
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

await run('createProject imports Codex CLI tool traces from native session logs', async () => {
  const tempBase = path.resolve('.tmp-tests');
  await mkdir(tempBase, { recursive: true });
  const tempRoot = await mkdtemp(path.join(tempBase, 'session-store-codex-import-traces-'));
  const userDataPath = path.join(tempRoot, 'userData');
  const homePath = path.join(tempRoot, 'home');
  const projectRoot = path.join(tempRoot, 'PBZ');
  const codexSessionsDir = path.join(homePath, '.codex', 'sessions', '2026', '04', '17');
  const codexIndexPath = path.join(homePath, '.codex', 'session_index.jsonl');

  await mkdir(userDataPath, { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  await mkdir(codexSessionsDir, { recursive: true });
  await mkdir(path.dirname(codexIndexPath), { recursive: true });

  await writeFile(
    codexIndexPath,
    `${JSON.stringify({
      id: 'trace-thread',
      thread_name: 'Trace import',
      updated_at: '2026-04-17T12:00:05.000Z',
    })}\n`,
    'utf8',
  );

  await writeFile(
    path.join(codexSessionsDir, 'rollout-2026-04-17T12-00-00-trace-thread.jsonl'),
    [
      JSON.stringify({
        timestamp: '2026-04-17T12:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'trace-thread',
          cwd: projectRoot,
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-17T12:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '检查 trace 导入' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-17T12:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'call-shell',
          name: 'apply_patch',
          arguments: JSON.stringify({
            patch: ['*** Begin Patch', '*** Update File: src/App.tsx', '@@', '-old', '+new', '*** End Patch'].join('\n'),
          }),
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-17T12:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call-shell',
          output: '{"output":"Success. Updated the following files:\\nM src/App.tsx\\n"}',
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-17T12:00:04.000Z',
        type: 'event_msg',
        payload: {
          type: 'exec_command_end',
          call_id: 'call-cmd',
          command: ['cmd.exe', '/d', '/s', '/c', 'git', 'status', '--short'],
          aggregated_output: ' M src/App.tsx',
          exit_code: 0,
          status: 'completed',
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-17T12:00:05.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '已检查完成。' }],
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
      (session: { codexThreadId?: string }) => session.codexThreadId === 'trace-thread',
    ) as
      | {
          messages?: Array<{ role?: string; kind?: string; title?: string; status?: string; content?: string }>;
        }
      | undefined;

    const toolMessages = imported?.messages?.filter((message) => message.role === 'system' && message.kind === 'tool_use') ?? [];
    assert.equal(toolMessages.length, 2);
    assert.equal(toolMessages[0]?.status, 'success');
    assert.match(toolMessages[0]?.content ?? '', /src\/App\.tsx/);
    assert.equal(toolMessages[1]?.title, 'Command');
    assert.equal(toolMessages[1]?.status, 'success');
    assert.match(toolMessages[1]?.content ?? '', /git status --short/);
  } finally {
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
  }
});

await run('native Codex import does not surface visible duplicates when persisted group session kinds were lost', async () => {
  const tempBase = path.resolve('.tmp-tests');
  await mkdir(tempBase, { recursive: true });
  const tempRoot = await mkdtemp(path.join(tempBase, 'session-store-codex-group-heal-'));
  const userDataPath = path.join(tempRoot, 'userData');
  const homePath = path.join(tempRoot, 'home');
  const projectRoot = path.join(tempRoot, 'PBZ');
  const codexSessionsDir = path.join(homePath, '.codex', 'sessions', '2026', '04', '12');
  const codexIndexPath = path.join(homePath, '.codex', 'session_index.jsonl');
  const storePath = path.join(userDataPath, 'easyaiflow-sessions.json');

  await mkdir(userDataPath, { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  await mkdir(codexSessionsDir, { recursive: true });
  await mkdir(path.dirname(codexIndexPath), { recursive: true });

  const previousUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = homePath;
  configureRuntimePaths({ mode: 'web', userDataPath, homePath });

  try {
    const sessionStore = await importFreshSessionStore();
    const project = await sessionStore.createProject('PBZ', projectRoot);
    const codexSession = await sessionStore.createSession(project.session.id, false, 'codex');
    await sessionStore.renameEntity('session', codexSession.session.id, 'Recovered room');
    await sessionStore.setSessionRuntime(codexSession.session.id, {
      codexThreadId: 'group-thread',
      model: 'gpt-5.4',
    });

    const room = await sessionStore.ensureGroupRoomSession(codexSession.session.id);
    await sessionStore.flushPendingSave();

    const broken = JSON.parse(await readFile(storePath, 'utf8')) as {
      projects: Array<{
        dreams: Array<{
          sessions: Array<Record<string, unknown>>;
        }>;
      }>;
    };
    broken.projects.forEach((projectRecord) => {
      projectRecord.dreams.forEach((dreamRecord) => {
        dreamRecord.sessions.forEach((sessionRecord) => {
          const group = sessionRecord.group as { kind?: string } | undefined;
          if (group?.kind === 'room' || group?.kind === 'member') {
            sessionRecord.sessionKind = 'standard';
          }
        });
      });
    });
    await writeFile(storePath, JSON.stringify(broken, null, 2), 'utf8');

    const codexParticipant =
      room.group?.kind === 'room'
        ? room.group.participants.find((participant: { id: string }) => participant.id === 'codex')
        : undefined;
    if (!codexParticipant) {
      throw new Error('Codex participant was not created.');
    }

    await writeFile(
      codexIndexPath,
      `${JSON.stringify({
        id: 'group-thread',
        thread_name: '[Group] Recovered room',
        updated_at: '2026-04-12T12:00:05.000Z',
      })}\n`,
      'utf8',
    );
    await writeFile(
      path.join(codexSessionsDir, 'rollout-2026-04-12T12-00-00-group-thread.jsonl'),
      [
        JSON.stringify({
          timestamp: '2026-04-12T12:00:00.000Z',
          type: 'session_meta',
          payload: {
            id: 'group-thread',
            cwd: projectRoot,
          },
        }),
        JSON.stringify({
          timestamp: '2026-04-12T12:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '继续之前的群聊' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-04-12T12:00:02.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: '还原后的 Codex backing。' }],
          },
        }),
        '',
      ].join('\n'),
      'utf8',
    );

    const reloadedStore = await importFreshSessionStore();
    const projects = await reloadedStore.getProjects();
    const temporary = projects[0]?.dreams.find((dream: { isTemporary?: boolean }) => dream.isTemporary);
    const visibleRecovered = temporary?.sessions.filter(
      (session: { title?: string; hidden?: boolean }) => session.title === '[Group] Recovered room' && !session.hidden,
    ) ?? [];
    const recoveredRoom = temporary?.sessions.find(
      (session: { id?: string; sessionKind?: string; title?: string }) =>
        session.id === room.id || (session.sessionKind === 'group' && session.title === 'Recovered room'),
    ) as { sessionKind?: string; title?: string } | undefined;

    const recoveredBacking = await reloadedStore.findSession(codexParticipant.backingSessionId);

    assert.equal(recoveredRoom?.sessionKind, 'group');
    assert.equal(recoveredBacking?.sessionKind, 'group_member');
    assert.equal(recoveredBacking?.hidden, true);
    assert.equal(visibleRecovered.length, 0);
  } finally {
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
  }
});

await run('loading persisted orphaned group backings recreates a visible room session', async () => {
  const tempBase = path.resolve('.tmp-tests');
  await mkdir(tempBase, { recursive: true });
  const tempRoot = await mkdtemp(path.join(tempBase, 'session-store-group-orphan-recovery-'));
  const userDataPath = path.join(tempRoot, 'userData');
  const homePath = path.join(tempRoot, 'home');
  const projectRoot = path.join(tempRoot, 'workspace');
  const storePath = path.join(userDataPath, 'easyaiflow-sessions.json');

  await mkdir(userDataPath, { recursive: true });
  await mkdir(homePath, { recursive: true });
  await mkdir(projectRoot, { recursive: true });

  await writeFile(
    storePath,
    JSON.stringify(
      {
        projects: [
          {
            id: 'project-1',
            name: 'Recovered',
            rootPath: projectRoot,
            dreams: [
              {
                id: 'dream-temp',
                name: 'Temporary',
                isTemporary: true,
                sessions: [
                  {
                    id: 'orphan-codex',
                    title: '[Group] Lost room',
                    preview: 'orphaned codex preview',
                    timeLabel: '4/12 12:00',
                    updatedAt: 1775966400000,
                    provider: 'codex',
                    model: 'gpt-5.4',
                    workspace: projectRoot,
                    projectId: 'project-1',
                    projectName: 'Recovered',
                    dreamId: 'dream-temp',
                    dreamName: 'Temporary',
                    codexThreadId: 'orphan-thread',
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
                    messages: [],
                  },
                ],
              },
            ],
          },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );

  const previousUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = homePath;
  configureRuntimePaths({ mode: 'web', userDataPath, homePath });

  try {
    const sessionStore = await importFreshSessionStore();
    const projects = await sessionStore.getProjects();
    const temporary = projects[0]?.dreams.find((dream: { isTemporary?: boolean }) => dream.isTemporary);
    const room = temporary?.sessions.find(
      (session: { title?: string; sessionKind?: string }) =>
        session.title === 'Lost room' && session.sessionKind === 'group',
    ) as
      | {
          id: string;
          group?: { kind?: string; participants?: Array<{ id: string; backingSessionId: string }> };
        }
      | undefined;

    assert.ok(room, 'Recovered room session was not created.');
    assert.equal(room?.group?.kind, 'room');
    assert.equal(room?.group?.participants?.length, 2);

    const codexBacking =
      room?.group?.participants?.find((participant) => participant.id === 'codex');
    const hiddenCodex = codexBacking
      ? await sessionStore.findSession(codexBacking.backingSessionId)
      : null;

    assert.equal(hiddenCodex?.id, 'orphan-codex');
    assert.equal(hiddenCodex?.sessionKind, 'group_member');
    assert.equal(hiddenCodex?.hidden, true);
    assert.equal(hiddenCodex?.title, '[Group] Lost room');
  } finally {
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
  }
});

await run('loading a partially recovered group room backfills richer Claude history from native sessions', async () => {
  const tempBase = path.resolve('.tmp-tests');
  await mkdir(tempBase, { recursive: true });
  const tempRoot = await mkdtemp(path.join(tempBase, 'session-store-group-claude-backfill-'));
  const userDataPath = path.join(tempRoot, 'userData');
  const homePath = path.join(tempRoot, 'home');
  const projectRoot = path.join(tempRoot, 'workspace');
  const storePath = path.join(userDataPath, 'easyaiflow-sessions.json');
  const claudeSessionId = 'native-claude-group';
  const claudeProjectsDir = path.join(
    homePath,
    '.claude',
    'projects',
    toClaudeProjectDirName(projectRoot) ?? 'workspace',
  );

  await mkdir(userDataPath, { recursive: true });
  await mkdir(homePath, { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  await mkdir(claudeProjectsDir, { recursive: true });

  await writeFile(
    path.join(claudeProjectsDir, `${claudeSessionId}.jsonl`),
    [
      JSON.stringify({
        type: 'custom-title',
        customTitle: '[Group] Lost room',
        sessionId: claudeSessionId,
      }),
      JSON.stringify({
        type: 'user',
        timestamp: '2026-04-12T04:48:41.529Z',
        cwd: projectRoot,
        sessionId: claudeSessionId,
        message: {
          role: 'user',
          content:
            'You are Claude in a shared chat room.\n' +
            "Write Claude's next reply to TARGET_MESSAGE.\n\n" +
            'TARGET_MESSAGE:\n' +
            '#2 [You] [message status=complete] title="@claude hi"\n' +
            '@claude hi\n\n' +
            'ROOM_CONTEXT through message #2:\n' +
            'Participants: Claude, Codex.\n' +
            '#1 [Codex] [message status=complete] title="Codex response"\n' +
            'hello\n\n' +
            '#2 [You] [message status=complete] title="@claude hi"\n' +
            '@claude hi\n\n' +
            'Reply as Claude:',
        },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-04-12T04:49:35.889Z',
        cwd: projectRoot,
        sessionId: claudeSessionId,
        message: {
          model: 'claude-opus-4-6',
          content: [{ type: 'text', text: 'Claude 完整回答。' }],
        },
      }),
      '',
    ].join('\n'),
    'utf8',
  );

  await writeFile(
    storePath,
    JSON.stringify(
      {
        projects: [
          {
            id: 'project-1',
            name: 'Recovered',
            rootPath: projectRoot,
            dreams: [
              {
                id: 'dream-temp',
                name: 'Temporary',
                isTemporary: true,
                sessions: [
                  {
                    id: 'room-1',
                    title: 'Lost room',
                    preview: 'hello',
                    timeLabel: '4/12 12:01',
                    updatedAt: 1775966400000,
                    model: '',
                    workspace: projectRoot,
                    projectId: 'project-1',
                    projectName: 'Recovered',
                    dreamId: 'dream-temp',
                    dreamName: 'Temporary',
                    sessionKind: 'group',
                    hidden: false,
                    group: {
                      kind: 'room',
                      nextMessageSeq: 4,
                      participants: [
                        {
                          id: 'claude',
                          label: 'Claude',
                          provider: 'claude',
                          backingSessionId: 'member-claude',
                          enabled: true,
                          model: 'opus[1m]',
                          lastAppliedRoomSeq: 0,
                        },
                        {
                          id: 'codex',
                          label: 'Codex',
                          provider: 'codex',
                          backingSessionId: 'member-codex',
                          enabled: true,
                          model: 'gpt-5.4',
                          lastAppliedRoomSeq: 0,
                        },
                      ],
                    },
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
                    messages: [
                      {
                        id: 'room-a1',
                        role: 'assistant',
                        seq: 1,
                        timestamp: '4/12 12:00',
                        title: 'Codex response',
                        content: 'hello',
                        speakerId: 'codex',
                        speakerLabel: 'Codex',
                        provider: 'codex',
                        status: 'complete',
                      },
                      {
                        id: 'room-u1',
                        role: 'user',
                        seq: 2,
                        timestamp: '4/12 12:00',
                        title: '@claude hi',
                        content: '@claude hi',
                        speakerId: 'user',
                        speakerLabel: 'You',
                        status: 'complete',
                      },
                      {
                        id: 'room-a2',
                        role: 'assistant',
                        seq: 3,
                        timestamp: '4/12 12:01',
                        title: 'Codex response',
                        content: 'hello',
                        speakerId: 'codex',
                        speakerLabel: 'Codex',
                        provider: 'codex',
                        status: 'complete',
                      },
                    ],
                  },
                  {
                    id: 'member-claude',
                    title: '[Group] Lost room',
                    preview: 'Claude group member session.',
                    timeLabel: '4/12 12:00',
                    updatedAt: 1775966400000,
                    provider: 'claude',
                    model: 'opus[1m]',
                    workspace: projectRoot,
                    projectId: 'project-1',
                    projectName: 'Recovered',
                    dreamId: 'dream-temp',
                    dreamName: 'Temporary',
                    sessionKind: 'group_member',
                    hidden: true,
                    group: {
                      kind: 'member',
                      roomSessionId: 'room-1',
                      participantId: 'claude',
                      speakerLabel: 'Claude',
                    },
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
                    messages: [],
                  },
                  {
                    id: 'member-codex',
                    title: '[Group] Lost room',
                    preview: 'Codex group member session.',
                    timeLabel: '4/12 12:01',
                    updatedAt: 1775966400000,
                    provider: 'codex',
                    model: 'gpt-5.4',
                    workspace: projectRoot,
                    projectId: 'project-1',
                    projectName: 'Recovered',
                    dreamId: 'dream-temp',
                    dreamName: 'Temporary',
                    codexThreadId: 'orphan-thread',
                    sessionKind: 'group_member',
                    hidden: true,
                    group: {
                      kind: 'member',
                      roomSessionId: 'room-1',
                      participantId: 'codex',
                      speakerLabel: 'Codex',
                    },
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
                    messages: [],
                  },
                ],
              },
            ],
          },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );

  const previousUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = homePath;
  configureRuntimePaths({ mode: 'web', userDataPath, homePath });

  try {
    const sessionStore = await importFreshSessionStore();
    const projects = await sessionStore.getProjects();
    const temporary = projects[0]?.dreams.find((dream: { isTemporary?: boolean }) => dream.isTemporary);
    const room = temporary?.sessions.find((session: { id?: string }) => session.id === 'room-1') as
      | {
          messages?: Array<{ role?: string; speakerLabel?: string; content?: string }>;
          preview?: string;
        }
      | undefined;
    const hiddenClaude = await sessionStore.findSession('member-claude');

    assert.equal(hiddenClaude?.claudeSessionId, claudeSessionId);
    assert.deepEqual(
      room?.messages?.map((message) => ({
        role: message.role,
        speakerLabel: message.speakerLabel,
        content: message.content,
      })),
      [
        {
          role: 'assistant',
          speakerLabel: 'Codex',
          content: 'hello',
        },
        {
          role: 'user',
          speakerLabel: 'You',
          content: '@claude hi',
        },
        {
          role: 'assistant',
          speakerLabel: 'Claude',
          content: 'Claude 完整回答。',
        },
      ],
    );
    assert.equal(room?.preview, 'Claude 完整回答。');
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

await run('deleteSession removes imported Codex threads from native storage so they do not reappear after reload', async () => {
  const tempBase = path.resolve('.tmp-tests');
  await mkdir(tempBase, { recursive: true });
  const tempRoot = await mkdtemp(path.join(tempBase, 'session-store-codex-delete-'));
  const userDataPath = path.join(tempRoot, 'userData');
  const homePath = path.join(tempRoot, 'home');
  const projectRoot = path.join(tempRoot, 'PBZ');
  const childWorkspace = path.join(projectRoot, 'ProjectPBZ');
  const codexSessionsDir = path.join(homePath, '.codex', 'sessions', '2026', '04', '06');
  const codexArchivedSessionsDir = path.join(homePath, '.codex', 'archived_sessions', '2026', '04', '06');
  const codexIndexPath = path.join(homePath, '.codex', 'session_index.jsonl');
  const activeThreadPath = path.join(codexSessionsDir, 'rollout-2026-04-06T12-00-00-delete-thread.jsonl');
  const archivedThreadPath = path.join(codexArchivedSessionsDir, 'rollout-2026-04-06T12-30-00-delete-thread.jsonl');

  await mkdir(userDataPath, { recursive: true });
  await mkdir(childWorkspace, { recursive: true });
  await mkdir(codexSessionsDir, { recursive: true });
  await mkdir(codexArchivedSessionsDir, { recursive: true });
  await mkdir(path.dirname(codexIndexPath), { recursive: true });

  await writeFile(
    codexIndexPath,
    `${JSON.stringify({
      id: 'delete-thread',
      thread_name: 'Temporary duplicate',
      updated_at: '2026-04-06T12:00:05.000Z',
    })}\n`,
    'utf8',
  );

  const nativeThreadContents = [
    JSON.stringify({
      timestamp: '2026-04-06T12:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: 'delete-thread',
        cwd: childWorkspace,
      },
    }),
    JSON.stringify({
      timestamp: '2026-04-06T12:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '删掉这个重复线程' }],
      },
    }),
    JSON.stringify({
      timestamp: '2026-04-06T12:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '这个线程稍后会被清理。' }],
      },
    }),
    '',
  ].join('\n');

  await writeFile(activeThreadPath, nativeThreadContents, 'utf8');
  await writeFile(archivedThreadPath, nativeThreadContents, 'utf8');

  const previousUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = homePath;
  configureRuntimePaths({ mode: 'web', userDataPath, homePath });

  try {
    const sessionStore = await importFreshSessionStore();
    const created = await sessionStore.createProject('PBZ', projectRoot);
    const temporary = created.projects[0]?.dreams.find((dream: { isTemporary?: boolean }) => dream.isTemporary);
    const imported = temporary?.sessions.find(
      (session: { codexThreadId?: string }) => session.codexThreadId === 'delete-thread',
    ) as { id: string } | undefined;

    assert.ok(imported);

    await sessionStore.deleteSession(imported.id);
    await sessionStore.flushPendingSave();

    const updatedIndex = await readFile(codexIndexPath, 'utf8');
    assert.doesNotMatch(updatedIndex, /"id":"delete-thread"/);

    let activeRemoved = false;
    try {
      await readFile(activeThreadPath, 'utf8');
    } catch {
      activeRemoved = true;
    }
    assert.equal(activeRemoved, true);

    let archivedRemoved = false;
    try {
      await readFile(archivedThreadPath, 'utf8');
    } catch {
      archivedRemoved = true;
    }
    assert.equal(archivedRemoved, true);

    await writeFile(
      codexIndexPath,
      `${JSON.stringify({
        id: 'delete-thread',
        thread_name: 'Temporary duplicate',
        updated_at: '2026-04-06T12:00:05.000Z',
      })}\n`,
      'utf8',
    );
    await mkdir(path.dirname(activeThreadPath), { recursive: true });
    await mkdir(path.dirname(archivedThreadPath), { recursive: true });
    await writeFile(activeThreadPath, nativeThreadContents, 'utf8');
    await writeFile(archivedThreadPath, nativeThreadContents, 'utf8');

    const reloadedStore = await importFreshSessionStore();
    const projects = await reloadedStore.getProjects();
    const reloadedTemporary = projects[0]?.dreams.find((dream: { isTemporary?: boolean }) => dream.isTemporary);
    const reimported = reloadedTemporary?.sessions.find(
      (session: { codexThreadId?: string }) => session.codexThreadId === 'delete-thread',
    );

    assert.equal(reimported, undefined);
  } finally {
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
  }
});
