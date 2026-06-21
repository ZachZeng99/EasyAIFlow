import assert from 'node:assert/strict';
import { attachLegacyEafTranscriptForFirstNativeClaudeRun } from '../backend/claudeInteraction.ts';
import type { PreparedClaudeRun } from '../backend/claudeInteractionState.ts';
import type { SessionRecord } from '../src/data/types.ts';

const run = async (name: string, fn: () => Promise<void> | void) => {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

const makeSession = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  id: '5d2d59a8-8eb0-4fc0-8c1b-c06e7b49de1f',
  title: 'Legacy Claude',
  preview: 'Earlier EAF answer',
  timeLabel: '6/16 22:10',
  updatedAt: 1,
  provider: 'claude',
  model: 'claude',
  workspace: 'X:\\AITool\\EasyAIFlow',
  projectId: 'project-1',
  projectName: 'EasyAIFlow',
  dreamId: 'dream-1',
  dreamName: 'Default',
  sessionKind: 'standard',
  hidden: false,
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
  messages: [
    {
      id: 'old-user',
      role: 'user',
      timestamp: '6/16 22:09',
      title: 'Old ask',
      content: 'Earlier EAF question',
      status: 'complete',
    },
    {
      id: 'old-assistant',
      role: 'assistant',
      timestamp: '6/16 22:10',
      title: 'Old answer',
      content: 'Earlier EAF answer',
      status: 'complete',
    },
  ],
  ...overrides,
});

const makePreparedRun = (session: SessionRecord): PreparedClaudeRun => ({
  sessionId: session.id,
  userMessageId: 'current-user',
  assistantMessageId: 'current-assistant',
  session,
  resolvedPrompt: 'Continue from the old discussion.',
  projects: [],
  assistantWasQueued: false,
  stopVersion: 0,
});

await run('attachLegacyEafTranscriptForFirstNativeClaudeRun carries EAF-only history into first native run', async () => {
  const prepared = makePreparedRun(makeSession());

  const attached = await attachLegacyEafTranscriptForFirstNativeClaudeRun(prepared);

  assert.equal(attached, true);
  assert.match(prepared.resolvedPrompt, /existing EasyAIFlow transcript/i);
  assert.match(prepared.resolvedPrompt, /Earlier EAF question/);
  assert.match(prepared.resolvedPrompt, /Earlier EAF answer/);
  assert.match(prepared.resolvedPrompt, /Current user message:\n\nContinue from the old discussion\./);
});

await run('attachLegacyEafTranscriptForFirstNativeClaudeRun leaves native Claude sessions unchanged', async () => {
  const prepared = makePreparedRun(makeSession({ claudeSessionId: 'native-session' }));

  const attached = await attachLegacyEafTranscriptForFirstNativeClaudeRun(prepared);

  assert.equal(attached, false);
  assert.equal(prepared.resolvedPrompt, 'Continue from the old discussion.');
});
