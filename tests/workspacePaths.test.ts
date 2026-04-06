import assert from 'node:assert/strict';
import { isWorkspaceWithinProjectTree, sameWorkspacePath } from '../electron/workspacePaths.js';

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

run('sameWorkspacePath treats Windows path variants as the same workspace', () => {
  assert.equal(sameWorkspacePath('X:\\PBZ\\ProjectPBZ', 'x:/pbz/projectpbz/'), true);
  assert.equal(sameWorkspacePath('X:\\PBZ', 'X:\\PBZ\\ProjectPBZ'), false);
});

run('isWorkspaceWithinProjectTree matches the project root and nested workspaces', () => {
  assert.equal(isWorkspaceWithinProjectTree('X:\\PBZ', 'x:/pbz/'), true);
  assert.equal(isWorkspaceWithinProjectTree('X:\\PBZ', 'X:\\PBZ\\ProjectPBZ'), true);
  assert.equal(isWorkspaceWithinProjectTree('X:\\PBZ\\ProjectPBZ', 'X:\\PBZ'), false);
});
