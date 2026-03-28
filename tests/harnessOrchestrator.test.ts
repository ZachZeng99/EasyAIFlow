import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { runHarnessOrchestration } from '../backend/harnessOrchestrator.ts';
import type { HarnessBootstrapResult, SessionRecord } from '../src/data/types.js';

const run = async (name: string, fn: () => Promise<void>) => {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

const makeSession = (
  id: string,
  title: string,
  workspace: string,
  harness?: SessionRecord['harness'],
): SessionRecord => ({
  id,
  title,
  preview: '',
  timeLabel: 'Just now',
  updatedAt: Date.now(),
  model: 'opus[1m]',
  workspace,
  projectId: 'project-1',
  projectName: 'EasyAIFlow',
  dreamId: 'dream-1',
  dreamName: 'Main Streamwork',
  claudeSessionId: undefined,
  instructionPrompt: undefined,
  harness,
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
  messages: [],
});

await run('runHarnessOrchestration completes after negotiation and retry loops', async () => {
  const tempBase = path.resolve('.tmp-tests');
  await mkdir(tempBase, { recursive: true });
  const tempRoot = await mkdtemp(path.join(tempBase, 'harness-orchestrator-'));
  const artifactDir = path.join(tempRoot, 'artifacts');
  await mkdir(artifactDir, { recursive: true });

  const rootSession = makeSession('root', 'Root ask', tempRoot);
  const plannerSession = makeSession('planner', '[planner] Root ask', tempRoot, {
    role: 'planner',
    rootSessionId: 'root',
    artifactDir,
  });
  const generatorSession = makeSession('generator', '[generator] Root ask', tempRoot, {
    role: 'generator',
    rootSessionId: 'root',
    artifactDir,
  });
  const evaluatorSession = makeSession('evaluator', '[evaluator] Root ask', tempRoot, {
    role: 'evaluator',
    rootSessionId: 'root',
    artifactDir,
  });
  const sessions = new Map(
    [rootSession, plannerSession, generatorSession, evaluatorSession].map((session) => [session.id, session]),
  );
  const bootstrap: HarnessBootstrapResult = {
    projects: [],
    rootSessionId: rootSession.id,
    plannerSessionId: plannerSession.id,
    generatorSessionId: generatorSession.id,
    evaluatorSessionId: evaluatorSession.id,
    artifactDir,
  };

  let contractRound = 0;
  let implementationRound = 0;

  const result = await runHarnessOrchestration({
    entrySessionId: rootSession.id,
    options: {
      maxSprints: 1,
      maxContractRounds: 2,
      maxImplementationRounds: 2,
    },
    bootstrapHarness: async () => bootstrap,
    findSession: async (sessionId) => sessions.get(sessionId) ?? null,
    runRoleTurn: async ({ sessionId, prompt }) => {
      if (sessionId === plannerSession.id) {
        return {
          content: [
            'PLANNER_STATUS: READY',
            'PLANNER_NEXT_SPRINT: Build the first vertical slice',
            'PLANNER_SUMMARY: Ready.',
          ].join('\n'),
        };
      }

      if (sessionId === generatorSession.id && prompt.includes('Plan sprint')) {
        contractRound += 1;
        return {
          content: [
            'SPRINT_STATUS: READY',
            'SPRINT_GOAL: Deliver the first slice',
            `SPRINT_SUMMARY: Proposal round ${contractRound}.`,
          ].join('\n'),
        };
      }

      if (sessionId === evaluatorSession.id && prompt.includes('Review the proposed sprint')) {
        return {
          content:
            contractRound === 1
              ? 'CONTRACT_DECISION: REVISE\nCONTRACT_REASON: Scope is too vague.'
              : 'CONTRACT_DECISION: APPROVED\nCONTRACT_REASON: Contract is testable.',
        };
      }

      if (sessionId === generatorSession.id && prompt.includes('Implement sprint')) {
        implementationRound += 1;
        return {
          content: [
            'IMPLEMENTATION_STATUS: COMPLETE',
            `IMPLEMENTATION_SUMMARY: Attempt ${implementationRound}.`,
            'IMPLEMENTATION_CHECKS: npm run check',
          ].join('\n'),
        };
      }

      if (sessionId === evaluatorSession.id && prompt.includes('QA sprint')) {
        return {
          content:
            implementationRound === 1
              ? [
                  'EVALUATION_DECISION: FAIL',
                  'EVALUATION_PRODUCT_DEPTH: 4',
                  'EVALUATION_FUNCTIONALITY: 3',
                  'EVALUATION_VISUAL_DESIGN: 4',
                  'EVALUATION_CODE_QUALITY: 4',
                  'EVALUATION_SUMMARY: One blocker remains.',
                  'EVALUATION_BLOCKERS: Fix the broken action.',
                ].join('\n')
              : [
                  'EVALUATION_DECISION: PASS',
                  'EVALUATION_PRODUCT_DEPTH: 4',
                  'EVALUATION_FUNCTIONALITY: 4',
                  'EVALUATION_VISUAL_DESIGN: 4',
                  'EVALUATION_CODE_QUALITY: 4',
                  'EVALUATION_SUMMARY: Sprint passes.',
                  'EVALUATION_BLOCKERS: none',
                ].join('\n'),
        };
      }

      throw new Error(`Unexpected prompt for ${sessionId}: ${prompt}`);
    },
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.completedSprints, 1);
  assert.equal(result.lastDecision, 'MAX_SPRINTS_REACHED');

  const manifest = JSON.parse(await readFile(path.join(artifactDir, 'manifest.json'), 'utf8')) as {
    status: string;
    completedSprints: number;
    timeline: Array<{ decision: string }>;
  };
  assert.equal(manifest.status, 'completed');
  assert.equal(manifest.completedSprints, 1);
  assert.ok(manifest.timeline.some((entry) => entry.decision === 'REVISE'));
  assert.ok(manifest.timeline.some((entry) => entry.decision === 'FAIL'));
  assert.ok(manifest.timeline.some((entry) => entry.decision === 'PASS'));
});

await run('runHarnessOrchestration fails when the contract never gets approved', async () => {
  const tempBase = path.resolve('.tmp-tests');
  await mkdir(tempBase, { recursive: true });
  const tempRoot = await mkdtemp(path.join(tempBase, 'harness-orchestrator-fail-'));
  const artifactDir = path.join(tempRoot, 'artifacts');
  await mkdir(artifactDir, { recursive: true });

  const rootSession = makeSession('root', 'Root ask', tempRoot);
  const plannerSession = makeSession('planner', '[planner] Root ask', tempRoot, {
    role: 'planner',
    rootSessionId: 'root',
    artifactDir,
  });
  const generatorSession = makeSession('generator', '[generator] Root ask', tempRoot, {
    role: 'generator',
    rootSessionId: 'root',
    artifactDir,
  });
  const evaluatorSession = makeSession('evaluator', '[evaluator] Root ask', tempRoot, {
    role: 'evaluator',
    rootSessionId: 'root',
    artifactDir,
  });
  const sessions = new Map(
    [rootSession, plannerSession, generatorSession, evaluatorSession].map((session) => [session.id, session]),
  );
  const bootstrap: HarnessBootstrapResult = {
    projects: [],
    rootSessionId: rootSession.id,
    plannerSessionId: plannerSession.id,
    generatorSessionId: generatorSession.id,
    evaluatorSessionId: evaluatorSession.id,
    artifactDir,
  };

  const result = await runHarnessOrchestration({
    entrySessionId: rootSession.id,
    options: {
      maxSprints: 1,
      maxContractRounds: 2,
      maxImplementationRounds: 1,
    },
    bootstrapHarness: async () => bootstrap,
    findSession: async (sessionId) => sessions.get(sessionId) ?? null,
    runRoleTurn: async ({ sessionId, prompt }) => {
      if (sessionId === plannerSession.id) {
        return {
          content: 'PLANNER_STATUS: READY\nPLANNER_NEXT_SPRINT: Start\nPLANNER_SUMMARY: Ready.',
        };
      }
      if (sessionId === generatorSession.id && prompt.includes('Plan sprint')) {
        return {
          content: 'SPRINT_STATUS: READY\nSPRINT_GOAL: Start\nSPRINT_SUMMARY: Proposed.',
        };
      }
      if (sessionId === evaluatorSession.id && prompt.includes('Review the proposed sprint')) {
        return {
          content: 'CONTRACT_DECISION: REVISE\nCONTRACT_REASON: Still too vague.',
        };
      }
      throw new Error(`Unexpected prompt for ${sessionId}`);
    },
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.lastDecision, 'CONTRACT_REJECTED');
});
