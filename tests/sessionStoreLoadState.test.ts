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
