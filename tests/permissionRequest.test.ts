import assert from 'node:assert/strict';
import { parsePermissionRequest } from '../src/data/permissionRequest.js';

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

run('parsePermissionRequest extracts a standard write permission prompt', () => {
  const request = parsePermissionRequest(
    "C:\\foo\\bar.md\nClaude requested permissions to write to C:\\foo\\bar.md, but you haven't granted it yet.",
  );

  assert.deepEqual(request, {
    action: 'write',
    targetPath: 'C:\\foo\\bar.md',
    sensitive: false,
  });
});

run('parsePermissionRequest extracts a sensitive-file edit prompt', () => {
  const request = parsePermissionRequest(
    'C:\\Users\\L\\.claude\\knowledge\\a.md Claude requested permissions to edit C:\\Users\\L\\.claude\\knowledge\\a.md which is a sensitive file.',
  );

  assert.deepEqual(request, {
    action: 'edit',
    targetPath: 'C:\\Users\\L\\.claude\\knowledge\\a.md',
    sensitive: true,
  });
});
