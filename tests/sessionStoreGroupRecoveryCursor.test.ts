import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
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

const makePrompt = (title: string, content: string) =>
  [
    '<task>',
    'You are Claude in a shared chat room about the current workspace.',
    '',
    'TARGET_MESSAGE:',
    `#1 [You] [message status=complete] title="${title}"`,
    content,
    '',
    'ROOM_CONTEXT through message #1:',
    'Participants: Claude, Codex.',
    `#1 [You] [message status=complete] title="${title}"`,
    content,
    '</task>',
  ].join('\n');

await run('group room recovery keeps per-participant lastAppliedRoomSeq at the last prompt each backing actually saw', async () => {
  const tempRoot = await mkdtemp(path.join(path.resolve('.tmp-tests'), 'session-store-group-recovery-cursor-'));
  const userDataPath = path.join(tempRoot, 'userData');
  const homePath = path.join(tempRoot, 'home');
  const storeFile = path.join(userDataPath, 'easyaiflow-sessions.json');

  await mkdir(userDataPath, { recursive: true });
  await mkdir(homePath, { recursive: true });

  const promptContent = '@all hi';
  const promptTitle = '@all hi';

  await writeFile(
    storeFile,
    JSON.stringify(
      {
        projects: [
          {
            id: 'project-1',
            name: 'Recovered',
            rootPath: 'D:\\PBZ',
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
                    workspace: 'D:\\PBZ',
                    projectId: 'project-1',
                    projectName: 'Recovered',
                    dreamId: 'dream-temp',
                    dreamName: 'Temporary',
                    sessionKind: 'group',
                    hidden: false,
                    group: {
                      kind: 'room',
                      nextMessageSeq: 1,
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
                    messages: [],
                  },
                  {
                    id: 'member-claude',
                    title: '[Group] Lost room',
                    preview: 'Claude group member session.',
                    timeLabel: '4/12 12:01',
                    updatedAt: 1775966401000,
                    provider: 'claude',
                    model: 'opus[1m]',
                    workspace: 'D:\\PBZ',
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
                    messages: [
                      {
                        id: 'claude-user-1',
                        role: 'user',
                        timestamp: '4/12 12:00',
                        title: 'Prompt',
                        content: makePrompt(promptTitle, promptContent),
                        status: 'complete',
                      },
                      {
                        id: 'claude-assistant-1',
                        role: 'assistant',
                        timestamp: '4/12 12:00',
                        title: 'Claude response',
                        content: 'Claude recovered reply.',
                        status: 'complete',
                      },
                    ],
                  },
                  {
                    id: 'member-codex',
                    title: '[Group] Lost room',
                    preview: 'Codex group member session.',
                    timeLabel: '4/12 12:01',
                    updatedAt: 1775966402000,
                    provider: 'codex',
                    model: 'gpt-5.4',
                    workspace: 'D:\\PBZ',
                    projectId: 'project-1',
                    projectName: 'Recovered',
                    dreamId: 'dream-temp',
                    dreamName: 'Temporary',
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
                    messages: [
                      {
                        id: 'codex-user-1',
                        role: 'user',
                        timestamp: '4/12 12:00',
                        title: 'Prompt',
                        content: makePrompt(promptTitle, promptContent),
                        status: 'complete',
                      },
                      {
                        id: 'codex-assistant-1',
                        role: 'assistant',
                        timestamp: '4/12 12:00',
                        title: 'Codex response',
                        content: 'Codex recovered reply.',
                        status: 'complete',
                      },
                    ],
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
    const room = await sessionStore.findSession('room-1');
    if (!room || room.group?.kind !== 'room') {
      throw new Error('Recovered room was not loaded.');
    }

    assert.deepEqual(
      room.group.participants.map((participant: { id: string; lastAppliedRoomSeq: number }) => ({
        id: participant.id,
        lastAppliedRoomSeq: participant.lastAppliedRoomSeq,
      })),
      [
        {
          id: 'claude',
          lastAppliedRoomSeq: 1,
        },
        {
          id: 'codex',
          lastAppliedRoomSeq: 1,
        },
      ],
    );
    assert.deepEqual(
      room.messages.map((message: { seq?: number; speakerId?: string }) => ({
        seq: message.seq,
        speakerId: message.speakerId ?? null,
      })),
      [
        {
          seq: 1,
          speakerId: 'user',
        },
        {
          seq: 2,
          speakerId: 'claude',
        },
        {
          seq: 3,
          speakerId: 'codex',
        },
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
