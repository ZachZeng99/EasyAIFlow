import assert from 'node:assert/strict';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContextPanel } from '../src/components/ContextPanel.tsx';
import type { GitSnapshot, SessionSummary } from '../src/data/types.ts';

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

const gitSnapshot: GitSnapshot = {
  branch: 'main',
  ahead: 0,
  behind: 0,
  dirty: false,
  changedFiles: [],
  source: 'mock',
};

const makeSession = (overrides?: Partial<SessionSummary>): SessionSummary => ({
  id: 'session-1',
  title: 'Session 1',
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
  ...overrides,
});

run('ContextPanel shows only Bootstrap Harness for eligible standard sessions', () => {
  const html = renderToStaticMarkup(
    createElement(ContextPanel, {
      session: makeSession(),
      appVersion: 'desktop',
      gitSnapshot,
      canBootstrapHarness: true,
      canRunHarness: false,
      onRequestDiff: async () => {
        throw new Error('not needed');
      },
      onBootstrapHarness: () => undefined,
      onRunHarness: () => undefined,
    }),
  );

  assert.match(html, /Bootstrap Harness/);
  assert.doesNotMatch(html, /Run Harness/);
});

run('ContextPanel shows only Run Harness for harness sessions', () => {
  const html = renderToStaticMarkup(
    createElement(ContextPanel, {
      session: makeSession({
        sessionKind: 'harness',
        harnessState: {
          plannerSessionId: 'planner',
          generatorSessionId: 'generator',
          evaluatorSessionId: 'evaluator',
          artifactDir: 'X:\\AITool\\EasyAIFlow\\.easyaiflow\\harness\\session-1',
          status: 'ready',
          currentStage: 'ready',
          currentSprint: 0,
          currentRound: 0,
          completedSprints: 0,
          maxSprints: 3,
          completedTurns: 0,
          totalTurns: 13,
          lastDecision: 'READY',
        },
      }),
      appVersion: 'desktop',
      gitSnapshot,
      canBootstrapHarness: false,
      canRunHarness: true,
      onRequestDiff: async () => {
        throw new Error('not needed');
      },
      onBootstrapHarness: () => undefined,
      onRunHarness: () => undefined,
    }),
  );

  assert.match(html, /Run Harness/);
  assert.doesNotMatch(html, /Bootstrap Harness/);
});
