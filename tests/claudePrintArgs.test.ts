import assert from 'node:assert/strict';
import { buildClaudePrintArgs } from '../electron/claudePrintArgs.js';

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

run('buildClaudePrintArgs uses stream-json input and permission prompt tool', () => {
  const args = buildClaudePrintArgs({
    model: 'sonnet',
    effort: 'high',
    sessionArgs: ['--resume', 'session-123'],
  });

  assert.deepEqual(args, [
    '--print',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--include-partial-messages',
    '--permission-mode',
    'default',
    '--permission-prompt-tool',
    'stdio',
    '--verbose',
    '--model',
    'sonnet',
    '--effort',
    'high',
    '--resume',
    'session-123',
  ]);
});

run('buildClaudePrintArgs omits model and effort when they are not supplied', () => {
  const args = buildClaudePrintArgs({
    sessionArgs: ['-n', 'BTW'],
  });

  assert.deepEqual(args, [
    '--print',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--include-partial-messages',
    '--permission-mode',
    'default',
    '--permission-prompt-tool',
    'stdio',
    '--verbose',
    '-n',
    'BTW',
  ]);
});
