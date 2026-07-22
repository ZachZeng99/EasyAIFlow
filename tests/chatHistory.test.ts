import assert from 'node:assert/strict';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatHistory, getSessionPinActionLabel } from '../src/components/ChatHistory.tsx';
import type { ProjectRecord, SessionSummary } from '../src/data/types.ts';

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

const makeSession = (overrides: Partial<SessionSummary> = {}): SessionSummary => ({
  id: overrides.id ?? 'session-1',
  title: overrides.title ?? 'Pinned thread',
  preview: '',
  timeLabel: 'Just now',
  updatedAt: overrides.updatedAt ?? 1,
  pinned: overrides.pinned,
  provider: 'codex',
  model: 'gpt-5.6',
  workspace: 'X:\\workspace',
  projectId: 'project-1',
  projectName: 'Project',
  dreamId: 'dream-1',
  dreamName: 'Streamwork',
  groups: [],
  tokenUsage: {
    contextWindow: 200_000,
    used: 1_000,
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
});

const renderHistory = (sessions: SessionSummary[]) => {
  const projects: ProjectRecord[] = [
    {
      id: 'project-1',
      name: 'Project',
      rootPath: 'X:\\workspace',
      dreams: [
        {
          id: 'dream-1',
          name: 'Streamwork',
          sessions,
        },
      ],
    },
  ];

  return renderToStaticMarkup(
    createElement(ChatHistory, {
      projects,
      selectedSessionId: '',
      sessionIndicators: {},
      onOpenProject: () => undefined,
      onCloseProject: () => undefined,
      onCreateStreamwork: () => undefined,
      onRenameStreamwork: () => undefined,
      onDeleteStreamwork: () => undefined,
      onCreateSession: () => undefined,
      onRenameSession: () => undefined,
      onDeleteSession: () => undefined,
      onSetSessionPinned: () => undefined,
      onCopySessionReference: () => undefined,
      onReorderStreamworks: () => undefined,
      onSelectSession: () => undefined,
    }),
  );
};

run('ChatHistory renders an accessible marker for pinned sessions', () => {
  const html = renderHistory([makeSession({ pinned: true })]);

  assert.match(html, /aria-label="Pinned session"/);
});

run('ChatHistory renders pinned sessions once with a dedicated ownership row', () => {
  const html = renderHistory([
    makeSession({ id: 'pinned', title: 'Global pin', pinned: true, updatedAt: 1 }),
    makeSession({ id: 'regular', title: 'Regular thread', pinned: false, updatedAt: 2 }),
  ]);
  const pinnedRegionIndex = html.indexOf('class="pinned-threads"');
  const projectTreeIndex = html.indexOf('class="history-tree"');

  assert.ok(pinnedRegionIndex >= 0);
  assert.ok(pinnedRegionIndex < projectTreeIndex);
  assert.match(html, /class="pinned-session-location" aria-label="Thread location"/);
  assert.match(
    html,
    /class="pinned-session-location-key">Project<\/span><strong[^>]*>Project<\/strong>/,
  );
  assert.match(
    html,
    /class="pinned-session-location-key">Streamwork<\/span><strong[^>]*>Streamwork<\/strong>/,
  );
  assert.doesNotMatch(html, /data-location-label=/);
  assert.equal(html.match(/Global pin/g)?.length, 1);
  assert.match(html, /Regular thread/);
});

run('ChatHistory exposes direct Pin and Unpin actions on session cards', () => {
  const regularHtml = renderHistory([makeSession({ pinned: false })]);
  const pinnedHtml = renderHistory([makeSession({ pinned: true })]);

  assert.match(regularHtml, /title="Pin thread"/);
  assert.match(pinnedHtml, /title="Unpin thread"/);
});

run('getSessionPinActionLabel describes the inverse action', () => {
  assert.equal(getSessionPinActionLabel(makeSession({ pinned: true })), 'Unpin thread');
  assert.equal(getSessionPinActionLabel(makeSession({ pinned: false })), 'Pin thread');
});
