import assert from 'node:assert/strict';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  extractBackgroundTaskResolutionFromToolUseResult,
  parseBackgroundLaunchFromToolResult,
} from '../backend/claudeInteraction.ts';
import {
  parseBackgroundTaskNotificationContent,
  parseClaudeBackgroundTaskEvent,
} from '../electron/backgroundTaskNotification.ts';
import {
  createClaudeRunState,
  markClaudeRunCompleted,
  shouldCompleteClaudeRunOnClose,
} from '../electron/claudeRunState.ts';
import { ContextPanel } from '../src/components/ContextPanel.tsx';
import { upsertSessionBackgroundTask } from '../src/data/sessionInteraction.ts';
import type {
  BackgroundTaskRecord,
  GitSnapshot,
  SessionSummary,
} from '../src/data/types.ts';

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
  id: 'session-bg',
  title: 'Background lifecycle',
  preview: 'Preview',
  timeLabel: 'Just now',
  updatedAt: Date.now(),
  model: 'opus[1m]',
  workspace: 'D:\\AIAgent\\EasyAIFlow',
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

run('parseClaudeBackgroundTaskEvent reads task lifecycle system messages', () => {
  const started = parseClaudeBackgroundTaskEvent({
    type: 'system',
    subtype: 'task_started',
    task_id: 'task-1',
    tool_use_id: 'tool-1',
    description: 'Run background review',
    task_type: 'local_agent',
  });
  const progress = parseClaudeBackgroundTaskEvent({
    type: 'system',
    subtype: 'task_progress',
    task_id: 'task-1',
    description: 'Run background review',
    summary: 'Planner finished',
    last_tool_name: 'Read',
    usage: {
      total_tokens: 321,
      tool_uses: 4,
      duration_ms: 1200,
    },
  });
  const completed = parseClaudeBackgroundTaskEvent({
    type: 'system',
    subtype: 'task_notification',
    task_id: 'task-1',
    tool_use_id: 'tool-1',
    status: 'completed',
    output_file: 'D:\\tmp\\task-1.txt',
    summary: 'Background review completed',
    usage: {
      total_tokens: 654,
      tool_uses: 7,
      duration_ms: 3200,
    },
  });

  assert.deepEqual(started, {
    taskId: 'task-1',
    status: 'running',
    description: 'Run background review',
    toolUseId: 'tool-1',
    taskType: 'local_agent',
    workflowName: undefined,
    prompt: undefined,
    updatedAt: started?.updatedAt,
  });
  assert.equal(progress?.summary, 'Planner finished');
  assert.equal(progress?.lastToolName, 'Read');
  assert.deepEqual(progress?.usage, {
    totalTokens: 321,
    toolUses: 4,
    durationMs: 1200,
  });
  assert.equal(completed?.status, 'completed');
  assert.equal(completed?.outputFile, 'D:\\tmp\\task-1.txt');
  assert.deepEqual(completed?.usage, {
    totalTokens: 654,
    toolUses: 7,
    durationMs: 3200,
  });
});

run('parseBackgroundTaskNotificationContent reads XML task notifications', () => {
  const task = parseBackgroundTaskNotificationContent(`<task-notification>
<task-id>task-xml</task-id>
<tool-use-id>tool-xml</tool-use-id>
<task-type>local_bash</task-type>
<output-file>D:\\tmp\\task-xml.log</output-file>
<status>killed</status>
<summary>Background command was stopped</summary>
<result>Subagent final answer.</result>
<usage>
<total_tokens>42</total_tokens>
<tool_uses>1</tool_uses>
<duration_ms>800</duration_ms>
</usage>
</task-notification>`);

  assert.deepEqual(task, {
    taskId: 'task-xml',
    status: 'stopped',
    description: 'Background command was stopped',
    toolUseId: 'tool-xml',
    taskType: 'local_bash',
    outputFile: 'D:\\tmp\\task-xml.log',
    summary: 'Background command was stopped',
    result: 'Subagent final answer.',
    usage: {
      totalTokens: 42,
      toolUses: 1,
      durationMs: 800,
    },
    updatedAt: task?.updatedAt,
  });
});

run('parseBackgroundLaunchFromToolResult ignores ordinary read results that only mention 后台 in prose', () => {
  const task = parseBackgroundLaunchFromToolResult({
    toolUseId: 'tool-read-memory',
    content: `1\t## UE Editor 操作规范
24\t- 启动编辑器后台任务 completed ≠ 编辑器退出。编辑器是独立进程，后台 shell 只是启动命令结束。`,
  });

  assert.equal(task, null);
});

run('parseBackgroundLaunchFromToolResult detects real background command launches from structured tool results', () => {
  const task = parseBackgroundLaunchFromToolResult({
    toolUseId: 'tool-bash-bg',
    content:
      'Command running in background with ID: b78b0ei9u. Output is being written to: C:\\Users\\Lenovo\\AppData\\Local\\Temp\\claude\\task.output',
    toolUseResult: {
      stdout: '',
      stderr: '',
      interrupted: false,
      isImage: false,
      noOutputExpected: false,
      backgroundTaskId: 'b78b0ei9u',
    },
  });

  assert.deepEqual(task, {
    taskId: 'b78b0ei9u',
    status: 'running',
    description: 'Background command task',
    toolUseId: 'tool-bash-bg',
    taskType: 'command',
    outputFile: 'C:\\Users\\Lenovo\\AppData\\Local\\Temp\\claude\\task.output',
    summary: 'Command running in background with ID: b78b0ei9u. Output is being written to: C:\\Users\\Lenovo\\AppData\\Local\\Temp\\claude\\task.output',
    updatedAt: task?.updatedAt,
  });
});

run('extractBackgroundTaskResolutionFromToolUseResult marks completed async agent results as settled', () => {
  const task = extractBackgroundTaskResolutionFromToolUseResult({
    resultText: '## Comprehensive Report\nThe task finished successfully.',
    toolUseResult: {
      status: 'completed',
      agentId: 'agent-finished-1',
    },
  });

  assert.deepEqual(task, {
    taskId: 'agent-finished-1',
    status: 'completed',
    result: '## Comprehensive Report\nThe task finished successfully.',
  });
});

run('shouldCompleteClaudeRunOnClose stays pending after result-only state and settles after close completion', () => {
  const resultSeen = {
    ...createClaudeRunState(),
    receivedResult: true,
    content: 'Primary answer',
    completedContent: undefined,
    needsCompletionRefresh: false,
  };

  assert.equal(shouldCompleteClaudeRunOnClose(resultSeen), true);

  const completed = markClaudeRunCompleted(resultSeen, resultSeen.content);
  assert.equal(shouldCompleteClaudeRunOnClose(completed), false);
});

run('upsertSessionBackgroundTask replaces existing tasks and keeps newest first', () => {
  const first: BackgroundTaskRecord = {
    taskId: 'task-1',
    status: 'running',
    description: 'Task one',
    updatedAt: 1,
  };
  const second: BackgroundTaskRecord = {
    taskId: 'task-2',
    status: 'completed',
    description: 'Task two',
    updatedAt: 3,
  };
  const firstUpdated: BackgroundTaskRecord = {
    taskId: 'task-1',
    status: 'completed',
    description: 'Task one done',
    updatedAt: 4,
  };

  const state = upsertSessionBackgroundTask(
    upsertSessionBackgroundTask(
      upsertSessionBackgroundTask({}, first),
      second,
    ),
    firstUpdated,
  );

  assert.deepEqual(state.backgroundTasks?.map((task) => task.taskId), ['task-1', 'task-2']);
  assert.equal(state.backgroundTasks?.[0]?.status, 'completed');
  assert.equal(state.backgroundTasks?.[0]?.description, 'Task one done');
});

run('ContextPanel renders background task state in the right rail', () => {
  const html = renderToStaticMarkup(
    createElement(ContextPanel, {
      session: makeSession(),
      messages: [],
      interaction: {
        runtime: {
          processActive: true,
          phase: 'idle',
          appliedEffort: 'high',
        },
        backgroundTasks: [
          {
            taskId: 'task-ctx',
            status: 'running',
            description: 'Analyze build logs',
            outputFile: 'D:\\tmp\\task-ctx.log',
            summary: 'Still parsing the latest chunk',
            usage: {
              totalTokens: 512,
              toolUses: 3,
              durationMs: 2400,
            },
            updatedAt: Date.now(),
          },
        ],
      },
      requestedEffort: 'max',
      appVersion: 'desktop',
      gitSnapshot,
      onRequestDiff: async () => {
        throw new Error('not needed');
      },
    }),
  );

  assert.match(html, /后台任务/);
  assert.match(html, /Thinking 状态/);
  assert.match(html, /Restart required/);
  assert.match(html, /Requested max · Active high/);
  assert.match(html, /Analyze build logs/);
  assert.match(html, /Still parsing the latest chunk/);
  assert.match(html, /task-ctx\.log/);
});
