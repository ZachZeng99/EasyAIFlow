import assert from 'node:assert/strict';
import { pruneTemporaryImportedDuplicates } from '../electron/importedSessionCleanup.js';
import type { SessionRecord } from '../src/data/types.js';

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

const makeSession = (id: string, title: string, used = 0): SessionRecord => ({
  id,
  title,
  preview: title,
  timeLabel: 'Imported',
  updatedAt: 1,
  provider: 'claude',
  model: 'opus[1m]',
  workspace: 'X:\\PBZ\\ProjectPBZ',
  projectId: 'p',
  projectName: 'ProjectPBZ',
  dreamId: 'temporary',
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

run('pruneTemporaryImportedDuplicates keeps the only duplicate entry with real token usage', () => {
  const result = pruneTemporaryImportedDuplicates([
    makeSession('old-a', 'Total', 0),
    makeSession('current', 'Total', 40480),
    makeSession('old-b', 'Total', 0),
  ]);

  assert.deepEqual(result.map((item) => item.id), ['current']);
});

run('pruneTemporaryImportedDuplicates keeps all duplicates when none has distinguishing token usage', () => {
  const result = pruneTemporaryImportedDuplicates([
    makeSession('a', 'Same Title', 0),
    makeSession('b', 'Same Title', 0),
  ]);

  assert.deepEqual(result.map((item) => item.id), ['a', 'b']);
});

run('pruneTemporaryImportedDuplicates keeps cross-provider sessions with the same title', () => {
  const claude = makeSession('claude', '[Group] Room', 0);
  const codex = {
    ...makeSession('codex', '[Group] Room', 50),
    provider: 'codex' as const,
    codexThreadId: 'codex-room',
    claudeSessionId: undefined,
    model: 'gpt-5.4-mini',
  };

  const result = pruneTemporaryImportedDuplicates([claude, codex]);

  assert.deepEqual(result.map((item) => item.id), ['claude', 'codex']);
});
