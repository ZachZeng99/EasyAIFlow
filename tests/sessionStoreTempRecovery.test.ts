import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
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

await run('loadState migrates a valid interrupted temp save without overwriting the corrupt V1 file', async () => {
  const tempRoot = await mkdtemp(path.join(path.resolve('.tmp-tests'), 'session-store-temp-recovery-'));
  const userDataPath = path.join(tempRoot, 'userData');
  const homePath = path.join(tempRoot, 'home');
  const storeFile = path.join(userDataPath, 'easyaiflow-sessions.json');
  const tempStoreFile = path.join(userDataPath, 'easyaiflow-sessions.json.1234.5678.tmp');

  await mkdir(userDataPath, { recursive: true });
  await mkdir(path.join(homePath, '.claude', 'projects'), { recursive: true });
  await writeFile(storeFile, '{"projects":', 'utf8');
  await writeFile(
    tempStoreFile,
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
    await sessionStore.flushPendingSave();
    const legacyAfter = await readFile(storeFile, 'utf8');
    const reloadedStore = await importFreshSessionStore();
    const reloadedProjects = await reloadedStore.getProjectsForBootstrap();
    await reloadedStore.flushPendingSave();
    const projectSummaries = projects.map((project) => ({
      name: project.name,
      rootPath: project.rootPath,
    }));

    assert.deepEqual(projectSummaries, [
      {
        name: 'ProjectPBZ',
        rootPath: 'X:\\PBZ\\ProjectPBZ',
      },
    ]);
    assert.equal(legacyAfter, '{"projects":');
    assert.deepEqual(
      reloadedProjects.map((project) => ({
        name: project.name,
        rootPath: project.rootPath,
      })),
      projectSummaries,
    );
  } finally {
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
  }
});

await run('loadState prefers a newer valid interrupted save over an older valid V1 file', async () => {
  const tempRoot = await mkdtemp(path.join(path.resolve('.tmp-tests'), 'session-store-newer-temp-'));
  const userDataPath = path.join(tempRoot, 'userData');
  const homePath = path.join(tempRoot, 'home');
  const storeFile = path.join(userDataPath, 'easyaiflow-sessions.json');
  const tempStoreFile = path.join(userDataPath, 'easyaiflow-sessions.json.1234.9999.tmp');
  const makeState = (name: string) => ({
    projects: [
      {
        id: 'project-1',
        name,
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
  });

  await mkdir(userDataPath, { recursive: true });
  await mkdir(path.join(homePath, '.claude', 'projects'), { recursive: true });
  await writeFile(storeFile, JSON.stringify(makeState('Older active')), 'utf8');
  await writeFile(tempStoreFile, JSON.stringify(makeState('Newer interrupted')), 'utf8');
  const nowSeconds = Date.now() / 1000;
  await utimes(storeFile, nowSeconds - 10, nowSeconds - 10);
  await utimes(tempStoreFile, nowSeconds, nowSeconds);

  const previousUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = homePath;
  configureRuntimePaths({ mode: 'web', userDataPath, homePath });

  try {
    const sessionStore = await importFreshSessionStore();
    const projects = await sessionStore.getProjectsForBootstrap();
    await sessionStore.flushPendingSave();
    assert.equal(projects[0]?.name, 'Newer interrupted');
    assert.equal(JSON.parse(await readFile(storeFile, 'utf8')).projects[0]?.name, 'Older active');
  } finally {
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
  }
});
