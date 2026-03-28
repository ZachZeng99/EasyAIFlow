import assert from 'node:assert/strict';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PlanModeDialog } from '../src/components/PlanModeDialog.tsx';

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

run('PlanModeDialog renders full plan review content and execution options', () => {
  const html = renderToStaticMarkup(
    createElement(PlanModeDialog, {
      open: true,
      request: {
        toolUseId: 'toolu_plan_exit',
        toolName: 'ExitPlanMode',
        plan: '# Plan\n\n1. Build the project\n2. Run tests',
        allowedPrompts: [
          {
            tool: 'Bash',
            prompt: 'build the project',
          },
        ],
      },
      busy: false,
      onSubmit: () => undefined,
    }),
  );

  assert.match(html, /class="dialog-card plan-mode-dialog"/);
  assert.match(html, /Ready To Exit Plan Mode/);
  assert.match(html, /Yes, clear context and auto-accept edits/);
  assert.match(html, /Yes, manually approve edits/);
  assert.match(html, /Tell Claude what to change/);
  assert.match(html, /Allowed prompts in this execution pass/);
  assert.match(html, /Continue/);
  assert.match(html, /build the project/);
});
