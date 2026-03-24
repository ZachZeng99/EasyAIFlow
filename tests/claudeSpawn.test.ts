import assert from 'node:assert/strict';
import { getClaudeSpawnOptions } from '../electron/claudeSpawn.js';

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

run('getClaudeSpawnOptions keeps stdin/stdout/stderr piped for control requests', () => {
  const options = getClaudeSpawnOptions('X:\\PBZ\\ProjectPBZ');

  assert.equal(options.cwd, 'X:\\PBZ\\ProjectPBZ');
  assert.equal(options.windowsHide, true);
  assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
});
