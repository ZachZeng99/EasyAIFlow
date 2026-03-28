import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
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

await run('bootstrapHarnessFromSession creates planner/generator/evaluator sessions and scaffold files', async () => {
  const tempBase = path.resolve('.tmp-tests');
  await mkdir(tempBase, { recursive: true });
  const tempRoot = await mkdtemp(path.join(tempBase, 'session-harness-bootstrap-'));
  const userDataPath = path.join(tempRoot, 'userData');
  const homePath = path.join(tempRoot, 'home');
  const workspace = path.join(tempRoot, 'workspace');
  const storeFile = path.join(userDataPath, 'easyaiflow-sessions.json');

  await mkdir(userDataPath, { recursive: true });
  await mkdir(homePath, { recursive: true });
  await mkdir(workspace, { recursive: true });

  await writeFile(
    storeFile,
    JSON.stringify(
      {
        projects: [
          {
            id: 'project-1',
            name: 'EasyAIFlow',
            rootPath: workspace,
            isClosed: false,
            dreams: [
              {
                id: 'temporary',
                name: 'Temporary',
                isTemporary: true,
                sessions: [],
              },
              {
                id: 'dream-1',
                name: 'Main Streamwork',
                sessions: [
                  {
                    id: 'session-1',
                    title: 'Build a long running harness',
                    preview: 'Start a new Claude conversation.',
                    timeLabel: '3/27 10:00',
                    updatedAt: Date.now(),
                    model: 'opus[1m]',
                    workspace,
                    projectId: 'project-1',
                    projectName: 'EasyAIFlow',
                    dreamId: 'dream-1',
                    dreamName: 'Main Streamwork',
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
    const result = await sessionStore.bootstrapHarnessFromSession('session-1');
    const sessions = result.projects[0]?.dreams[1]?.sessions ?? [];
    const harnessSessions = sessions.filter((session: { harness?: { role?: string } }) => session.harness);
    const rootSession = sessions.find((session: { id: string }) => session.id === result.rootSessionId) as
      | { sessionKind?: string; hidden?: boolean; harnessState?: { status?: string } }
      | undefined;
    const artifactDir = path.join(workspace, '.easyaiflow', 'harness', 'session-1');

    assert.equal(result.artifactDir, artifactDir);
    assert.equal(result.rootSessionId, 'session-1');
    assert.deepEqual(
      harnessSessions.map((session: { harness?: { role?: string } }) => session.harness?.role).sort(),
      ['evaluator', 'generator', 'planner'],
    );
    assert.equal(rootSession?.sessionKind, 'harness');
    assert.equal(rootSession?.hidden, false);
    assert.equal(rootSession?.harnessState?.status, 'ready');

    await Promise.all([
      access(path.join(artifactDir, 'product-spec.md')),
      access(path.join(artifactDir, 'sprint-contract.md')),
      access(path.join(artifactDir, 'evaluation-report.md')),
      access(path.join(artifactDir, 'handoff.md')),
    ]);

    const planner = harnessSessions.find(
      (session: { id: string }) => session.id === result.plannerSessionId,
    ) as { instructionPrompt?: string } | undefined;
    assert.match(planner?.instructionPrompt ?? '', /Role: planner\./);

    const manifest = JSON.parse(await readFile(path.join(artifactDir, 'manifest.json'), 'utf8')) as {
      sourceSessionId?: string;
    };
    assert.equal(manifest.sourceSessionId, 'session-1');
  } finally {
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
  }
});
