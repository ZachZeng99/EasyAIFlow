import assert from 'node:assert/strict';
import {
  buildPlanModeFollowUpPrompt,
  buildPlanModeResponseText,
  buildPlanModeTraceContent,
  parsePlanModeRequest,
} from '../src/data/planMode.ts';

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

run('parsePlanModeRequest extracts exit plan payloads', () => {
  const request = parsePlanModeRequest({
    toolName: 'ExitPlanMode',
    toolUseId: 'toolu_plan_exit',
    input: {
      plan: '# Plan\n\n1. Build the project\n2. Run tests',
      allowedPrompts: [
        {
          tool: 'Bash',
          prompt: 'build the project',
        },
      ],
    },
  });

  assert.deepEqual(request, {
    toolUseId: 'toolu_plan_exit',
    toolName: 'ExitPlanMode',
    plan: '# Plan\n\n1. Build the project\n2. Run tests',
    allowedPrompts: [
      {
        tool: 'Bash',
        prompt: 'build the project',
      },
    ],
  });
});

run('buildPlanModeTraceContent includes the full plan and execution options', () => {
  const content = buildPlanModeTraceContent({
    toolUseId: 'toolu_plan_exit',
    toolName: 'ExitPlanMode',
    plan: '# Plan\n\n1. Build',
    allowedPrompts: [
      {
        tool: 'Bash',
        prompt: 'build the project',
      },
    ],
  });

  assert.match(content, /# Plan/);
  assert.match(content, /## Execution Options/);
  assert.match(content, /`Bash` - build the project/);
});

run('buildPlanModeResponseText describes an approved execution choice', () => {
  const text = buildPlanModeResponseText(
    {
      toolUseId: 'toolu_plan_exit',
      toolName: 'ExitPlanMode',
      plan: '# Plan',
      allowedPrompts: [
        {
          tool: 'Bash',
          prompt: 'build the project',
        },
      ],
    },
    {
      mode: 'approve_accept_edits',
      selectedPromptIndex: 0,
      notes: 'Run the fast build first.',
    },
  );

  assert.match(text, /approved your plan/i);
  assert.match(text, /auto-approved/i);
  assert.match(text, /Run the fast build first\./);
});

run('buildPlanModeFollowUpPrompt produces a resumable fallback prompt', () => {
  const prompt = buildPlanModeFollowUpPrompt(
    {
      toolUseId: 'toolu_plan_exit',
      toolName: 'ExitPlanMode',
      plan: '# Plan',
      allowedPrompts: [
        {
          tool: 'Bash',
          prompt: 'build the project',
        },
      ],
    },
    {
      mode: 'revise',
      notes: 'Add a verification step.',
    },
  );

  assert.match(prompt, /Plan review decision:/);
  assert.match(prompt, /Decision: revise/);
  assert.match(prompt, /Add a verification step\./);
});
