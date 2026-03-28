import assert from 'node:assert/strict';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HarnessDashboard } from '../src/components/HarnessDashboard.tsx';
import type { SessionRecord } from '../src/data/types.ts';

(globalThis as typeof globalThis & { React?: typeof React }).React = React;

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

const makeSession = (
  id: string,
  title: string,
  overrides?: Partial<SessionRecord>,
): SessionRecord => ({
  id,
  title,
  preview: 'Preview',
  timeLabel: 'Just now',
  updatedAt: Date.now(),
  model: 'opus[1m]',
  workspace: 'X:\\AITool\\EasyAIFlow',
  projectId: 'project-1',
  projectName: 'EasyAIFlow',
  dreamId: 'dream-1',
  dreamName: 'Main Streamwork',
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
  messages: [],
  ...overrides,
});

run('HarnessDashboard renders owner, stage, sprint progress, and role panes', () => {
  const root = makeSession('root', 'Shader Audit Harness', {
    sessionKind: 'harness',
    harnessState: {
      plannerSessionId: 'planner',
      generatorSessionId: 'generator',
      evaluatorSessionId: 'evaluator',
      artifactDir: 'X:\\AITool\\EasyAIFlow\\.easyaiflow\\harness\\root',
      status: 'running',
      currentOwner: 'generator',
      currentStage: 'implementation',
      currentSprint: 1,
      currentRound: 1,
      completedSprints: 0,
      maxSprints: 3,
      completedTurns: 3,
      totalTurns: 13,
      lastDecision: 'APPROVED',
      summary: 'Generator is implementing sprint 1.',
    },
  });
  const planner = makeSession('planner', '[planner] Shader Audit Harness', {
    sessionKind: 'harness_role',
    hidden: true,
  });
  const generator = makeSession('generator', '[generator] Shader Audit Harness', {
    sessionKind: 'harness_role',
    hidden: true,
    messages: [
      {
        id: 'assistant-1',
        role: 'assistant',
        timestamp: '3/27 21:00',
        title: 'Implementation started',
        content: 'Working through the approved sprint contract.',
        status: 'streaming',
      },
    ],
  });
  const evaluator = makeSession('evaluator', '[evaluator] Shader Audit Harness', {
    sessionKind: 'harness_role',
    hidden: true,
  });

  const html = renderToStaticMarkup(
    createElement(HarnessDashboard, {
      session: root,
      plannerSession: planner,
      generatorSession: generator,
      evaluatorSession: evaluator,
    }),
  );

  assert.match(html, /Shader Audit Harness/);
  assert.match(html, /implementation/i);
  assert.match(html, /generator/i);
  assert.match(html, /Progress 3 \/ 13/);
  assert.match(html, /Planner/);
  assert.match(html, /Generator/);
  assert.match(html, /Evaluator/);
});
