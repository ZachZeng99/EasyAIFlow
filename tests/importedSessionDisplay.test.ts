import assert from 'node:assert/strict';
import { resolveImportedSessionDisplay } from '../electron/importedSessionDisplay.js';
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

const existing = {
  id: 'existing',
  title: '"X:\\MEM\\PS5-Development-159945-20260316-20',
  preview: '"X:\\MEM\\PS5-Development..." 总结一下这个报告',
  timeLabel: 'Imported',
  updatedAt: 123,
  model: 'opus[1m]',
  workspace: 'X:\\PBZ\\ProjectPBZ',
  projectId: 'p',
  projectName: 'p',
  dreamId: 'd',
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
} satisfies SessionRecord;

run('resolveImportedSessionDisplay refreshes stale imported titles from parsed native data', () => {
  const display = resolveImportedSessionDisplay(existing, {
    title: 'Invalid API key',
    preview: '"X:\\MEM\\PS5-Development..." 总结一下这个报告',
    timeLabel: 'Imported',
    updatedAt: 456,
  });

  assert.equal(display.title, 'Invalid API key');
  assert.equal(display.preview, '"X:\\MEM\\PS5-Development..." 总结一下这个报告');
  assert.equal(display.updatedAt, 123);
});
