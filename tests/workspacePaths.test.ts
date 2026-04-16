import assert from 'node:assert/strict';
import { getClaudeProjectDirNameCandidates, toClaudeProjectDirName } from '../electron/workspacePaths.ts';

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

run('toClaudeProjectDirName matches Claude project folder naming on Windows workspaces', () => {
  assert.equal(
    toClaudeProjectDirName('D:\\AIAgent\\EasyAIFlow-eaf_codex'),
    'D--AIAgent-EasyAIFlow-eaf-codex',
  );
});

run('getClaudeProjectDirNameCandidates keeps compatibility with older derived folder names', () => {
  assert.deepEqual(
    getClaudeProjectDirNameCandidates('D:\\AIAgent\\EasyAIFlow-eaf_codex'),
    [
      'D--AIAgent-EasyAIFlow-eaf-codex',
      'D--AIAgent-EasyAIFlow-eaf_codex',
      'D--aiagent-easyaiflow-eaf_codex',
      'D--aiagent-easyaiflow-eaf-codex',
    ],
  );
});
