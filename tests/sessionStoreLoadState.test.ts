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

await run('loadState preserves persisted projects when native session import hits an unreadable entry', async () => {
  const tempRoot = await mkdtemp(path.join(path.resolve('.tmp-tests'), 'session-store-loadstate-'));
  const userDataPath = path.join(tempRoot, 'userData');
  const homePath = path.join(tempRoot, 'home');
  const storeFile = path.join(userDataPath, 'easyaiflow-sessions.json');

  await mkdir(userDataPath, { recursive: true });
  await mkdir(path.join(homePath, '.claude', 'projects', 'X--PBZ-ProjectPBZ', 'broken.jsonl'), {
    recursive: true,
  });

  await writeFile(
    storeFile,
    JSON.stringify(
      {
        projects: [
          {
            id: 'project-1',
            name: 'ProjectPBZ',
            rootPath: 'X:\\PBZ\\ProjectPBZ',
            isClosed: false,
            dreams: [
              {
                id: 'temporary',
                name: 'Temporary',
                isTemporary: true,
                sessions: [],
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
    const persistedAfter = JSON.parse(await readFile(storeFile, 'utf8')) as {
      projects: Array<{ name: string; rootPath: string }>;
    };

    assert.deepEqual(
      projects.map((project) => ({
        name: project.name,
        rootPath: project.rootPath,
      })),
      [
        {
          name: 'ProjectPBZ',
          rootPath: 'X:\\PBZ\\ProjectPBZ',
        },
      ],
    );
    assert.deepEqual(
      persistedAfter.projects.map((project) => ({
        name: project.name,
        rootPath: project.rootPath,
      })),
      [
        {
          name: 'ProjectPBZ',
          rootPath: 'X:\\PBZ\\ProjectPBZ',
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

await run('bootstrap reads persisted projects and sessions without native import', async () => {
  const tempRoot = await mkdtemp(path.join(path.resolve('.tmp-tests'), 'session-store-bootstrap-'));
  const userDataPath = path.join(tempRoot, 'userData');
  const homePath = path.join(tempRoot, 'home');
  const projectRoot = 'X:\\PBZ\\ProjectPBZ';
  const storeFile = path.join(userDataPath, 'easyaiflow-sessions.json');

  await mkdir(userDataPath, { recursive: true });
  await mkdir(path.join(homePath, '.claude', 'projects', 'X--PBZ-ProjectPBZ'), {
    recursive: true,
  });
  await writeFile(
    path.join(homePath, '.claude', 'projects', 'X--PBZ-ProjectPBZ', 'native-only.jsonl'),
    [
      JSON.stringify({
        type: 'user',
        sessionId: 'native-only',
        cwd: projectRoot,
        timestamp: '2026-05-06T01:00:00.000Z',
        message: {
          content: [{ type: 'text', text: 'native prompt' }],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        sessionId: 'native-only',
        cwd: projectRoot,
        timestamp: '2026-05-06T01:00:01.000Z',
        message: {
          content: [{ type: 'text', text: 'native reply' }],
        },
      }),
    ].join('\n'),
    'utf8',
  );

  await writeFile(
    storeFile,
    JSON.stringify(
      {
        projects: [
          {
            id: 'project-1',
            name: 'ProjectPBZ',
            rootPath: projectRoot,
            isClosed: false,
            dreams: [
              {
                id: 'temporary',
                name: 'Temporary',
                isTemporary: true,
                sessions: [],
              },
              {
                id: 'main',
                name: 'Main Streamwork',
                sessions: [
                  {
                    id: 'session-1',
                    title: 'Persisted session',
                    preview: 'persisted reply',
                    timeLabel: 'Just now',
                    updatedAt: 1,
                    provider: 'claude',
                    model: 'opus[1m]',
                    workspace: projectRoot,
                    projectId: 'project-1',
                    projectName: 'ProjectPBZ',
                    dreamId: 'main',
                    dreamName: 'Main Streamwork',
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
                    messages: [
                      {
                        id: 'message-1',
                        role: 'assistant',
                        kind: 'message',
                        timestamp: 'Just now',
                        title: 'Persisted reply',
                        content: 'persisted reply',
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
    const projects = await sessionStore.getProjectsForBootstrap();
    const session = await sessionStore.getSessionRecordForBootstrap('session-1');
    const bootstrapSessions = projects.flatMap((project) =>
      project.dreams.flatMap((dream) => dream.sessions),
    );

    assert.equal(projects.length, 1);
    assert.equal(bootstrapSessions.length, 1);
    assert.equal(bootstrapSessions[0]?.id, 'session-1');
    assert.equal(bootstrapSessions[0]?.messagesLoaded, false);
    assert.deepEqual(bootstrapSessions[0]?.messages, []);
    assert.equal(session?.id, 'session-1');
    assert.equal(session?.messages[0]?.content, 'persisted reply');
  } finally {
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
  }
});
