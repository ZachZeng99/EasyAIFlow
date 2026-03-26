import assert from 'node:assert/strict';
import { buildRecordedCodeChangeDiff } from '../electron/recordedCodeChangeDiff.ts';

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

run('buildRecordedCodeChangeDiff captures an Edit replacement as a synthetic diff', () => {
  const payload = buildRecordedCodeChangeDiff('Edit', {
    file_path: 'X:\\PBZ\\ProjectPBZ\\Config\\DefaultEngine.ini',
    old_string: 'r.RayTracing=True',
    new_string: 'r.RayTracing=False',
  });

  assert.equal(payload?.kind, 'git');
  assert.match(payload?.content ?? '', /-r\.RayTracing=True/);
  assert.match(payload?.content ?? '', /\+r\.RayTracing=False/);
});

run('buildRecordedCodeChangeDiff captures Write content as a recorded preview', () => {
  const payload = buildRecordedCodeChangeDiff('Write', {
    file_path: 'X:\\PBZ\\ProjectPBZ\\PS5_MemoryOptimization_AssetChanges.md',
    content: '# Asset changes\n- item',
  });

  assert.equal(payload?.kind, 'preview');
  assert.equal(payload?.content, '# Asset changes\n- item');
});
