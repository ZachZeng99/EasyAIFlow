import assert from 'node:assert/strict';
import { shouldIgnoreImportedProgress } from '../electron/importedProgressFilter.js';

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

run('shouldIgnoreImportedProgress hides session-start hook progress noise', () => {
  assert.equal(
    shouldIgnoreImportedProgress({
      dataType: 'hook_progress',
      hookEvent: 'SessionStart',
      command: '"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd" session-start',
    }),
    true,
  );
});

run('shouldIgnoreImportedProgress keeps non-startup progress visible', () => {
  assert.equal(
    shouldIgnoreImportedProgress({
      dataType: 'hook_progress',
      hookEvent: 'PostToolUse',
      command: 'callback',
    }),
    false,
  );
});
