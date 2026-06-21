import assert from 'node:assert/strict';

import { applyClaudeEventToProjects } from '../src/data/liveSessionEvents.ts';
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

const makeMessage = (
  id: string,
  content: string,
  overrides: Partial<ConversationMessage> = {},
): ConversationMessage => ({
  id,
  role: 'user',
  timestamp: 'now',
  title: 'User prompt',
  content,
  status: 'complete',
  ...overrides,
});

const makeSession = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  id: 'session-1',
  title: 'Session',
  workspace: 'X:\\repo',
  preview: '',
  timeLabel: '',
  updatedAt: 1,
  messages: [makeMessage('user-1', 'question')],
  messagesLoaded: true,
  provider: 'claude',
  model: 'opus',
  projectId: 'project-1',
  dreamId: 'dream-1',
  sessionKind: 'standard',
  hidden: false,
  ...overrides,
});

const makeProjects = (session: SessionRecord = makeSession()): ProjectRecord[] => [
  {
    id: 'project-1',
    name: 'Project',
    rootPath: 'X:\\repo',
    dreams: [
      {
        id: 'dream-1',
        name: 'Main',
        sessions: [session],
      },
    ],
  },
];

const getSession = (projects: ProjectRecord[]) =>
  projects[0]?.dreams[0]?.sessions[0] as SessionRecord;

run('applyClaudeEventToProjects creates an assistant message when a status event arrives before its trace placeholder', () => {
  const projects = applyClaudeEventToProjects(makeProjects(), {
    type: 'status',
    sessionId: 'session-1',
    messageId: 'assistant-1',
    status: 'streaming',
    title: 'Claude response',
    content: 'working',
  });

  const session = getSession(projects);
  const assistant = session.messages[1];

  assert.equal(assistant?.id, 'assistant-1');
  assert.equal(assistant?.role, 'assistant');
  assert.equal(assistant?.title, 'Claude response');
  assert.equal(assistant?.content, 'working');
  assert.equal(assistant?.status, 'streaming');
  assert.equal(session.preview, 'working');
});

run('applyClaudeEventToProjects accumulates deltas even if the first delta arrives before its trace placeholder', () => {
  const first = applyClaudeEventToProjects(makeProjects(), {
    type: 'delta',
    sessionId: 'session-1',
    messageId: 'assistant-1',
    delta: 'hel',
  });
  const second = applyClaudeEventToProjects(first, {
    type: 'delta',
    sessionId: 'session-1',
    messageId: 'assistant-1',
    delta: 'lo',
  });

  const assistant = getSession(second).messages[1];

  assert.equal(assistant?.id, 'assistant-1');
  assert.equal(assistant?.role, 'assistant');
  assert.equal(assistant?.content, 'hello');
  assert.equal(assistant?.status, 'streaming');
});

run('applyClaudeEventToProjects preserves newer streamed content if the trace placeholder arrives late', () => {
  const withDelta = applyClaudeEventToProjects(makeProjects(), {
    type: 'delta',
    sessionId: 'session-1',
    messageId: 'assistant-1',
    delta: 'visible text',
  });
  const withLateTrace = applyClaudeEventToProjects(withDelta, {
    type: 'trace',
    sessionId: 'session-1',
    message: makeMessage('assistant-1', '', {
      role: 'assistant',
      title: 'Claude response',
      status: 'streaming',
    }),
  });

  const assistant = getSession(withLateTrace).messages[1];

  assert.equal(assistant?.content, 'visible text');
  assert.equal(assistant?.title, 'Claude response');
  assert.equal(assistant?.status, 'streaming');
});
