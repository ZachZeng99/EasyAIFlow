import assert from 'node:assert/strict';
import { mergeNativeImportedSessions } from '../electron/nativeSessionMerge.js';
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

const makeSession = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  id: overrides.id ?? 'session',
  title: overrides.title ?? 'Session',
  preview: overrides.preview ?? 'Preview',
  timeLabel: overrides.timeLabel ?? 'Imported',
  updatedAt: overrides.updatedAt ?? 1,
  model: overrides.model ?? 'opus[1m]',
  workspace: overrides.workspace ?? 'X:\\PBZ\\ProjectPBZ',
  projectId: overrides.projectId ?? 'project',
  projectName: overrides.projectName ?? 'ProjectPBZ',
  dreamId: overrides.dreamId ?? 'temporary',
  dreamName: overrides.dreamName ?? 'Temporary',
  claudeSessionId: overrides.claudeSessionId,
  groups: overrides.groups ?? [],
  contextReferences: overrides.contextReferences ?? [],
  tokenUsage: overrides.tokenUsage ?? {
    contextWindow: 0,
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

run('mergeNativeImportedSessions removes an empty generated placeholder when imported history exists', () => {
  const placeholder = makeSession({
    id: 'placeholder',
    title: 'New Session 1',
    preview: 'Start a new Claude conversation.',
    updatedAt: 500,
  });
  const imported = makeSession({
    id: 'imported',
    title: 'Imported Session',
    claudeSessionId: 'native-1',
    updatedAt: 100,
  });

  const merged = mergeNativeImportedSessions([placeholder], [imported], new Set(['native-1']));

  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, 'imported');
});

run('mergeNativeImportedSessions keeps meaningful local sessions and sorts by updatedAt descending', () => {
  const local = makeSession({
    id: 'local',
    title: 'Scratch',
    preview: 'Draft',
    updatedAt: 300,
    messages: [
      {
        id: 'msg-1',
        role: 'user',
        timestamp: 'now',
        title: 'Draft',
        content: 'Work in progress',
      },
    ],
  });
  const importedOld = makeSession({
    id: 'imported-old',
    title: 'Old Imported',
    claudeSessionId: 'native-old',
    updatedAt: 100,
  });
  const importedNew = makeSession({
    id: 'imported-new',
    title: 'New Imported',
    claudeSessionId: 'native-new',
    updatedAt: 400,
  });

  const merged = mergeNativeImportedSessions(
    [local],
    [importedOld, importedNew],
    new Set(['native-old', 'native-new']),
  );

  assert.deepEqual(
    merged.map((session) => session.id),
    ['imported-new', 'local', 'imported-old'],
  );
});

run('mergeNativeImportedSessions drops stale imported placeholders that no longer parse into real history', () => {
  const staleImported = makeSession({
    id: 'stale-imported',
    title: 'Imported e4643a0c',
    preview: 'Imported Claude history.',
    claudeSessionId: 'e4643a0c-d155-4ddf-a88d-307a803a137b',
    updatedAt: 500,
    messages: [],
  });
  const local = makeSession({
    id: 'local',
    title: 'Scratch',
    preview: 'Draft',
    updatedAt: 300,
    messages: [
      {
        id: 'msg-1',
        role: 'user',
        timestamp: 'now',
        title: 'Draft',
        content: 'Work in progress',
      },
    ],
  });

  const merged = mergeNativeImportedSessions(
    [staleImported, local],
    [],
    new Set(),
  );

  assert.deepEqual(
    merged.map((session) => session.id),
    ['local'],
  );
});
