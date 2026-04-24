import assert from 'node:assert/strict';
import { mergeSessionStoreStates } from '../electron/sessionStoreMerge.ts';
import type {
  BranchSnapshot,
  DreamRecord,
  ProjectRecord,
  SessionRecord,
} from '../src/data/types.ts';

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

const branchSnapshot: BranchSnapshot = {
  branch: 'main',
  ahead: 0,
  behind: 0,
  dirty: false,
  changedFiles: [],
};

const makeSession = (
  id: string,
  title: string,
  provider: 'claude' | 'codex',
  projectId: string,
  projectName: string,
  dreamId: string,
  dreamName: string,
  updatedAt: number,
): SessionRecord => ({
  id,
  title,
  preview: title,
  timeLabel: 'Just now',
  updatedAt,
  provider,
  model: provider === 'claude' ? 'opus[1m]' : 'gpt-5.5',
  workspace: 'D:\\PBZ',
  projectId,
  projectName,
  dreamId,
  dreamName,
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
  branchSnapshot,
  messages: [],
});

const makeDream = (
  id: string,
  name: string,
  sessions: SessionRecord[],
  isTemporary = false,
): DreamRecord => ({
  id,
  name,
  isTemporary,
  sessions,
});

const makeProject = (
  id: string,
  dreams: DreamRecord[],
): ProjectRecord => ({
  id,
  name: 'PBZ',
  rootPath: 'D:\\PBZ',
  isClosed: false,
  dreams,
});

run('mergeSessionStoreStates preserves streamworks and sessions from both stale and fresh processes for the same workspace', () => {
  const diskProject = makeProject('project-old', [
    makeDream(
      'temporary-old',
      'Temporary',
      [
        makeSession(
          'session-temp-old',
          'Lumen温习',
          'claude',
          'project-old',
          'PBZ',
          'temporary-old',
          'Temporary',
          10,
        ),
      ],
      true,
    ),
    makeDream(
      'dream-review',
      '提交评估',
      [
        makeSession(
          'session-review',
          'AGC_setConstantBuffers',
          'claude',
          'project-old',
          'PBZ',
          'dream-review',
          '提交评估',
          20,
        ),
      ],
    ),
  ]);

  const memoryProject = makeProject('project-new', [
    makeDream(
      'temporary-new',
      'Temporary',
      [
        makeSession(
          'session-temp-new',
          'New Session 1',
          'claude',
          'project-new',
          'PBZ',
          'temporary-new',
          'Temporary',
          30,
        ),
        makeSession(
          'session-review-temp',
          'AGC_setConstantBuffers',
          'claude',
          'project-new',
          'PBZ',
          'temporary-new',
          'Temporary',
          40,
        ),
      ],
      true,
    ),
    makeDream('main-new', 'Main Streamwork', []),
  ]);

  const merged = mergeSessionStoreStates(
    {
      projects: [diskProject],
      deletedImports: {
        claudeSessionIds: ['claude-a'],
        codexThreadIds: [],
      },
    },
    {
      projects: [memoryProject],
      deletedImports: {
        claudeSessionIds: [],
        codexThreadIds: ['codex-a'],
      },
    },
  );

  assert.equal(merged.projects.length, 1);
  const project = merged.projects[0];
  if (!project) {
    throw new Error('Merged project missing.');
  }

  assert.equal(project.id, 'project-new');
  assert.deepEqual(
    project.dreams.map((dream) => dream.name),
    ['Temporary', 'Main Streamwork', '提交评估'],
  );

  const recoveredDream = project.dreams.find((dream) => dream.name === '提交评估');
  assert.equal(recoveredDream?.sessions.length, 1);
  assert.equal(recoveredDream?.sessions[0]?.title, 'AGC_setConstantBuffers');
  assert.equal(recoveredDream?.sessions[0]?.projectId, 'project-new');
  assert.equal(recoveredDream?.sessions[0]?.dreamName, '提交评估');

  const temporaryDream = project.dreams.find((dream) => dream.name === 'Temporary');
  assert.equal(temporaryDream?.sessions.length, 3);
  assert.equal(
    temporaryDream?.sessions.some((session) => session.title === 'Lumen温习'),
    true,
  );

  assert.deepEqual(merged.deletedImports, {
    claudeSessionIds: ['claude-a'],
    codexThreadIds: ['codex-a'],
  });
});
