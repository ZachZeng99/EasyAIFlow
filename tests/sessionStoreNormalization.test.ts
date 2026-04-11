import assert from 'node:assert/strict';
import {
  normalizeProjectsForCache,
  normalizeProjectsFromPersistence,
} from '../electron/sessionStoreNormalization.ts';
import type { ConversationMessage, ProjectRecord, SessionRecord } from '../src/data/types.ts';

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

const makeMessage = (overrides: Partial<ConversationMessage>): ConversationMessage => ({
  id: overrides.id ?? 'assistant-1',
  role: overrides.role ?? 'assistant',
  kind: overrides.kind,
  timestamp: overrides.timestamp ?? 'now',
  title: overrides.title ?? 'Claude response',
  content: overrides.content ?? '',
  status: overrides.status ?? 'streaming',
});

const makeProject = (message: ConversationMessage): ProjectRecord[] => {
  const session: SessionRecord = {
    id: 'session-1',
    title: 'Session 1',
    preview: '',
    timeLabel: 'Just now',
    updatedAt: 1,
    provider: 'claude',
    model: 'opus[1m]',
    workspace: 'X:\\AITool\\EasyAIFlow',
    projectId: 'project-1',
    projectName: 'EasyAIFlow',
    dreamId: 'dream-1',
    dreamName: 'Main',
    claudeSessionId: 'native-1',
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
    messages: [message],
  };

  return [
    {
      id: 'project-1',
      name: 'EasyAIFlow',
      rootPath: 'X:\\AITool\\EasyAIFlow',
      dreams: [
        {
          id: 'dream-1',
          name: 'Main',
          sessions: [session],
        },
      ],
    },
  ];
};

run('normalizeProjectsForCache preserves active streaming assistant messages', () => {
  const projects = makeProject(
    makeMessage({
      status: 'streaming',
      title: 'Claude response',
      content: '',
    }),
  );

  const normalized = normalizeProjectsForCache(projects);
  const message = normalized[0]?.dreams[0]?.sessions[0]?.messages?.[0];

  assert.equal(message?.status, 'streaming');
  assert.equal(message?.title, 'Claude response');
  assert.equal(message?.content, '');
});

run('normalizeProjectsFromPersistence still recovers stale streaming assistant messages', () => {
  const projects = makeProject(
    makeMessage({
      status: 'streaming',
      title: 'Claude response',
      content: '',
    }),
  );

  const normalized = normalizeProjectsFromPersistence(projects);
  const message = normalized[0]?.dreams[0]?.sessions[0]?.messages?.[0];

  assert.equal(message?.status, 'error');
  assert.equal(message?.content, 'Previous Claude run did not finish.');
});

run('normalizeProjectsFromPersistence preserves provider and applies provider-specific recovery copy', () => {
  const projects = makeProject(
    makeMessage({
      status: 'queued',
      title: 'Codex queued',
      content: '',
    }),
  );
  const session = projects[0]?.dreams[0]?.sessions[0] as SessionRecord;
  session.provider = 'codex';
  session.model = 'gpt-5.4';

  const normalized = normalizeProjectsFromPersistence(projects);
  const recoveredSession = normalized[0]?.dreams[0]?.sessions[0] as SessionRecord | undefined;
  const message = recoveredSession?.messages?.[0];

  assert.equal(recoveredSession?.provider, 'codex');
  assert.equal(message?.status, 'error');
  assert.equal(message?.title, 'Codex queue interrupted');
  assert.equal(message?.content, 'Queued Codex run did not resume after restart.');
});

run('normalizeProjectsFromPersistence recovers stale streaming messages in group room sessions', () => {
  const projects = makeProject(
    makeMessage({
      status: 'streaming',
      title: 'Claude response',
      content: '',
      provider: 'claude',
      speakerId: 'claude',
      speakerLabel: 'Claude',
    }),
  );
  const session = projects[0]?.dreams[0]?.sessions[0] as SessionRecord;
  session.provider = undefined;
  session.model = '';
  session.sessionKind = 'group';
  session.group = {
    kind: 'room',
    nextMessageSeq: 3,
    participants: [],
  };

  const normalized = normalizeProjectsFromPersistence(projects);
  const message = normalized[0]?.dreams[0]?.sessions[0]?.messages?.[0];

  assert.equal(message?.status, 'error');
  assert.equal(message?.content, 'Previous Claude run did not finish.');
});

run('normalizeProjectsFromPersistence completes non-empty streaming group room messages', () => {
  const projects = makeProject(
    makeMessage({
      status: 'streaming',
      title: 'Codex response',
      content: 'partial reply from codex',
      provider: 'codex',
      speakerId: 'codex',
      speakerLabel: 'Codex',
    }),
  );
  const session = projects[0]?.dreams[0]?.sessions[0] as SessionRecord;
  session.provider = undefined;
  session.model = '';
  session.sessionKind = 'group';
  session.group = {
    kind: 'room',
    nextMessageSeq: 3,
    participants: [],
  };

  const normalized = normalizeProjectsFromPersistence(projects);
  const message = normalized[0]?.dreams[0]?.sessions[0]?.messages?.[0];

  assert.equal(message?.status, 'complete');
  assert.equal(message?.content, 'partial reply from codex');
});

run('normalizeProjectsForCache keeps group sessions provider-less', () => {
  const projects = makeProject(
    makeMessage({
      status: 'complete',
      title: 'Group room',
      content: '@claude review this',
    }),
  );
  const session = projects[0]?.dreams[0]?.sessions[0] as SessionRecord;
  session.provider = undefined;
  session.model = '';
  session.sessionKind = 'group';
  session.group = {
    kind: 'room',
    nextMessageSeq: 2,
    participants: [],
  };

  const normalized = normalizeProjectsForCache(projects);
  const normalizedSession = normalized[0]?.dreams[0]?.sessions[0] as SessionRecord | undefined;

  assert.equal(normalizedSession?.sessionKind, 'group');
  assert.equal(normalizedSession?.provider, undefined);
});
