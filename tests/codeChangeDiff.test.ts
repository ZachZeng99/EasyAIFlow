import assert from 'node:assert/strict';
import { getDisplayedCodeChangeDiff, shouldRequestCodeChangeDiff } from '../src/data/codeChangeDiff.ts';
import type { DiffPayload } from '../src/data/types.ts';

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

const missingPayload: DiffPayload = {
  filePath: 'X:\\PBZ\\ProjectPBZ\\PS5_MemoryOptimization_AssetChanges.md',
  kind: 'missing',
  content: 'No diff available for this file.',
};

const previewPayload: DiffPayload = {
  filePath: missingPayload.filePath,
  kind: 'preview',
  content: '# Asset changes',
};

run('shouldRequestCodeChangeDiff retries when the cached payload is missing', () => {
  assert.equal(
    shouldRequestCodeChangeDiff({
      nextOpen: true,
      hasRequestDiff: true,
      currentPayload: missingPayload,
      isLoading: false,
    }),
    true,
  );
});

run('shouldRequestCodeChangeDiff skips reload when a usable payload already exists', () => {
  assert.equal(
    shouldRequestCodeChangeDiff({
      nextOpen: true,
      hasRequestDiff: true,
      currentPayload: previewPayload,
      isLoading: false,
    }),
    false,
  );
});

run('getDisplayedCodeChangeDiff prefers the recorded edit-time payload over live workspace lookup', () => {
  const recordedPayload: DiffPayload = {
    filePath: missingPayload.filePath,
    kind: 'git',
    content: '@@\n-old\n+new',
  };

  assert.deepEqual(
    getDisplayedCodeChangeDiff({
      recordedPayload,
      loadedPayload: previewPayload,
    }),
    recordedPayload,
  );
});
