import assert from 'node:assert/strict';
import { shouldForkResidentClaudeSession } from '../backend/claudeInteraction.ts';

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

run('shouldForkResidentClaudeSession keeps standard sessions on fork when settings change', () => {
  assert.equal(
    shouldForkResidentClaudeSession({
      session: {
        claudeSessionId: 'claude-session',
        sessionKind: 'standard',
      },
      persistedModel: 'opus[1m]',
      resolvedModel: 'sonnet',
      hasResident: true,
      effortChanged: false,
    }),
    true,
  );
});

run('shouldForkResidentClaudeSession avoids forking group member sessions', () => {
  assert.equal(
    shouldForkResidentClaudeSession({
      session: {
        claudeSessionId: 'claude-group-member',
        sessionKind: 'group_member',
      },
      persistedModel: 'opus[1m]',
      resolvedModel: 'opus[1m]',
      hasResident: true,
      effortChanged: true,
    }),
    false,
  );
});
