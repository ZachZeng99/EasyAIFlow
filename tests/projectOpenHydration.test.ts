import assert from 'node:assert/strict';
import { hydrateProjectForOpen } from '../electron/projectOpen.js';
import type { ProjectRecord, SessionRecord } from '../src/data/types.js';

const run = async (name: string, fn: () => Promise<void>) => {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

const makeProject = (): ProjectRecord => ({
  id: 'project-1',
  name: 'ProjectPBZ',
  rootPath: 'X:\\PBZ\\ProjectPBZ',
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
      sessions: [],
    },
  ],
});

const makeSession = (id: string, title: string): SessionRecord => ({
  id,
  title,
  preview: title,
  timeLabel: 'Imported',
  updatedAt: 1,
  model: 'opus[1m]',
  workspace: 'X:\\PBZ\\ProjectPBZ',
  projectId: 'project-1',
  projectName: 'ProjectPBZ',
  dreamId: 'temporary',
  dreamName: 'Temporary',
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
});

const ensureSession = (project: ProjectRecord) => {
  const temporary = project.dreams.find((dream) => dream.isTemporary)!;
  if (temporary.sessions.length > 0) {
    return temporary.sessions[0] as SessionRecord;
  }

  const fallback = makeSession('new-session', 'New Session 1');
  temporary.sessions.unshift(fallback);
  return fallback;
};

await run('hydrateProjectForOpen prefers imported Claude history on first open', async () => {
  const project = makeProject();
  const imported = makeSession('imported-session', 'Imported Session');

  const session = await hydrateProjectForOpen(
    project,
    async (target) => {
      const temporary = target.dreams.find((dream) => dream.isTemporary)!;
      temporary.sessions.push(imported);
    },
    ensureSession,
  );

  assert.equal(session.id, 'imported-session');
  assert.equal(project.dreams[0].sessions.length, 1);
});

await run('hydrateProjectForOpen falls back to a blank session when no history exists', async () => {
  const project = makeProject();

  const session = await hydrateProjectForOpen(project, async () => undefined, ensureSession);

  assert.equal(session.title, 'New Session 1');
  assert.equal(project.dreams[0].sessions.length, 1);
});
