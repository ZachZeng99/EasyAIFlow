import assert from 'node:assert/strict';
import { findImportedSessionTarget } from '../electron/importedSessionMatch.js';
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

const makeSession = (overrides: Partial<SessionRecord>): SessionRecord => ({
  id: overrides.id ?? 'id',
  title: overrides.title ?? 'Title',
  preview: overrides.preview ?? 'preview',
  timeLabel: overrides.timeLabel ?? 'Imported',
  updatedAt: overrides.updatedAt ?? 1,
  model: overrides.model ?? 'opus[1m]',
  workspace: overrides.workspace ?? 'X:\\PBZ\\ProjectPBZ',
  projectId: overrides.projectId ?? 'p',
  projectName: overrides.projectName ?? 'ProjectPBZ',
  dreamId: overrides.dreamId ?? 'd',
  dreamName: overrides.dreamName ?? 'Temporary',
  claudeSessionId: overrides.claudeSessionId,
  groups: overrides.groups ?? [],
  contextReferences: overrides.contextReferences ?? [],
  tokenUsage: overrides.tokenUsage ?? {
    contextWindow: 1000000,
    used: 0,
    input: 0,
    output: 0,
    cached: 0,
    windowSource: 'unknown',
  },
  branchSnapshot: overrides.branchSnapshot ?? {
    branch: 'main',
    ahead: 0,
    behind: 0,
    dirty: false,
    changedFiles: [],
  },
  messages: overrides.messages ?? [],
});

run('findImportedSessionTarget prefers exact claudeSessionId match', () => {
  const direct = makeSession({ id: 'direct', claudeSessionId: 'native-1', dreamName: 'Memory' });
  const result = findImportedSessionTarget([direct], 'native-1', 'Total', 'X:\\PBZ\\ProjectPBZ');
  assert.equal(result?.id, 'direct');
});

run('findImportedSessionTarget falls back to a unique non-temporary title match', () => {
  const memory = makeSession({ id: 'memory', title: 'Total', dreamName: 'Memory' });
  const temp = makeSession({ id: 'temp', title: 'Total', dreamName: 'Temporary' });
  const result = findImportedSessionTarget([memory, temp], 'new-native', 'Total', 'X:\\PBZ\\ProjectPBZ');
  assert.equal(result?.id, 'memory');
});
