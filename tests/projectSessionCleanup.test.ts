import assert from 'node:assert/strict';
import { cleanupProjectSessions } from '../electron/projectSessionCleanup.js';
import type { ProjectRecord, SessionRecord } from '../src/data/types.js';

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

const makeSession = (id: string, title: string, used = 0, updatedAt = 1): SessionRecord => ({
  id,
  title,
  preview: title,
  timeLabel: 'Imported',
  updatedAt,
  provider: 'claude',
  model: 'opus[1m]',
  workspace: 'X:\\PBZ\\ProjectPBZ',
  projectId: 'p',
  projectName: 'ProjectPBZ',
  dreamId: 'd',
  dreamName: 'Temporary',
  claudeSessionId: `${id}-claude`,
  groups: [],
  contextReferences: [],
  tokenUsage: {
    contextWindow: 1000000,
    used,
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

run('cleanupProjectSessions prefers non-temporary copies when the same session id exists twice', () => {
  const shared = makeSession('same-id', 'Total', 10, 20);
  const project: ProjectRecord = {
    id: 'p',
    name: 'ProjectPBZ',
    rootPath: 'X:\\PBZ\\ProjectPBZ',
    dreams: [
      { id: 'tmp', name: 'Temporary', isTemporary: true, sessions: [{ ...shared, dreamId: 'tmp', dreamName: 'Temporary' }] },
      { id: 'mem', name: 'Memory', sessions: [{ ...shared, dreamId: 'mem', dreamName: 'Memory' }] },
    ],
  };

  const cleaned = cleanupProjectSessions(project);

  assert.equal(cleaned.dreams[0].sessions.length, 0);
  assert.equal(cleaned.dreams[1].sessions.length, 1);
});

run('cleanupProjectSessions prunes temporary duplicate titles when one has real token usage', () => {
  const project: ProjectRecord = {
    id: 'p',
    name: 'ProjectPBZ',
    rootPath: 'X:\\PBZ\\ProjectPBZ',
    dreams: [
      {
        id: 'tmp',
        name: 'Temporary',
        isTemporary: true,
        sessions: [
          { ...makeSession('old-a', 'Total', 0, 1), dreamId: 'tmp', dreamName: 'Temporary' },
          { ...makeSession('current', 'Total', 40, 3), dreamId: 'tmp', dreamName: 'Temporary' },
          { ...makeSession('old-b', 'Total', 0, 2), dreamId: 'tmp', dreamName: 'Temporary' },
        ],
      },
    ],
  };

  const cleaned = cleanupProjectSessions(project);

  assert.deepEqual(cleaned.dreams[0].sessions.map((session) => session.id), ['current']);
});

run('cleanupProjectSessions prefers non-temporary session when the same title exists in Temporary and another streamwork', () => {
  const project: ProjectRecord = {
    id: 'p',
    name: 'ProjectPBZ',
    rootPath: 'X:\\PBZ\\ProjectPBZ',
    dreams: [
      {
        id: 'tmp',
        name: 'Temporary',
        isTemporary: true,
        sessions: [
          { ...makeSession('temp-total', 'Total', 40, 30), dreamId: 'tmp', dreamName: 'Temporary' },
        ],
      },
      {
        id: 'mem',
        name: 'Memory',
        sessions: [
          { ...makeSession('memory-total', 'Total', 41, 31), dreamId: 'mem', dreamName: 'Memory' },
        ],
      },
    ],
  };

  const cleaned = cleanupProjectSessions(project);

  assert.equal(cleaned.dreams[0].sessions.length, 0);
  assert.deepEqual(cleaned.dreams[1].sessions.map((session) => session.id), ['memory-total']);
});

run('cleanupProjectSessions keeps same-title Claude and Codex sessions as separate entries', () => {
  const project: ProjectRecord = {
    id: 'p',
    name: 'ProjectPBZ',
    rootPath: 'X:\\PBZ\\ProjectPBZ',
    dreams: [
      {
        id: 'tmp',
        name: 'Temporary',
        isTemporary: true,
        sessions: [
          { ...makeSession('claude-group', '[Group] Room', 10, 30), dreamId: 'tmp', dreamName: 'Temporary' },
          {
            ...makeSession('codex-group', '[Group] Room', 11, 31),
            provider: 'codex',
            codexThreadId: 'codex-group-thread',
            claudeSessionId: undefined,
            model: 'gpt-5.5-mini',
            dreamId: 'tmp',
            dreamName: 'Temporary',
          },
        ],
      },
    ],
  };

  const cleaned = cleanupProjectSessions(project);

  assert.deepEqual(cleaned.dreams[0].sessions.map((session) => session.id), ['claude-group', 'codex-group']);
});
