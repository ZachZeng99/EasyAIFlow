import assert from 'node:assert/strict';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatThread } from '../src/components/ChatThread.js';
import type { ConversationMessage, SessionSummary } from '../src/data/types.js';

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

const session: SessionSummary = {
  id: 'session-1',
  title: 'Collapsed process test',
  preview: 'Preview',
  timeLabel: '20:53',
  model: 'gpt-5',
  workspace: 'X:\\AITool\\EasyAIFlow',
  projectId: 'project-1',
  projectName: 'EasyAIFlow',
  dreamId: 'stream-1',
  dreamName: 'UI polish',
  groups: [],
  tokenUsage: {
    contextWindow: 200000,
    used: 1000,
    input: 600,
    output: 400,
    cached: 0,
  },
  branchSnapshot: {
    branch: 'main',
    ahead: 0,
    behind: 0,
    dirty: false,
    changedFiles: [],
  },
};

const messages: ConversationMessage[] = [
  {
    id: 'assistant-1',
    role: 'assistant',
    timestamp: '3/23 20:53',
    title: 'Reply',
    content: 'Implemented.',
  },
  {
    id: 'tool-1',
    role: 'system',
    kind: 'tool_use',
    timestamp: '3/23 20:52',
    title: 'Read',
    content: 'Read src/components/ChatThread.tsx',
    status: 'success',
  },
];

run('ChatThread keeps process groups collapsed by default', () => {
  const html = renderToStaticMarkup(
    createElement(ChatThread, {
      session,
      messages,
    }),
  );

  assert.match(html, /Process/);
  assert.match(html, /1 steps/);
  assert.doesNotMatch(html, /trace-group-list/);
  assert.doesNotMatch(html, />Read</);
  assert.ok(html.indexOf('Process') < html.indexOf('Implemented.'));
});

run('ChatThread expands failed process groups and shows an inline failure reason', () => {
  const html = renderToStaticMarkup(
    createElement(ChatThread, {
      session,
      messages: [
        {
          id: 'assistant-2',
          role: 'assistant',
          timestamp: '4/4 20:28',
          title: 'Claude response',
          content: '好问题，让我确认一下源码。',
          status: 'complete',
        },
        {
          id: 'tool-agent-1',
          role: 'system',
          kind: 'tool_use',
          timestamp: '4/4 20:28',
          title: 'Agent',
          content:
            '{\n  "subagent_type": "Explore"\n}\n[Request interrupted by user for tool use]',
          status: 'error',
        },
      ],
    }),
  );

  assert.match(html, /trace-group-list/);
  assert.match(html, />Agent</);
  assert.match(html, /\[Request interrupted by user for tool use\]/);
  assert.ok(html.indexOf('Process') < html.indexOf('好问题，让我确认一下源码。'));
});
