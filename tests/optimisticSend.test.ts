import assert from 'node:assert/strict';
import { buildOptimisticSendState, reconcileOptimisticSendMessages } from '../src/data/optimisticSend.js';
import type { ContextReference, PendingAttachment, ProjectRecord, SessionRecord } from '../src/data/types.js';

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

const makeSession = (): SessionRecord => ({
  id: 'session-1',
  title: 'Session 1',
  preview: 'Earlier preview',
  timeLabel: 'Yesterday',
  updatedAt: 1,
  provider: 'claude',
  model: 'opus[1m]',
  workspace: 'X:\\AITool\\EasyAIFlow',
  projectId: 'project-1',
  projectName: 'EasyAIFlow',
  dreamId: 'dream-1',
  dreamName: 'Main Streamwork',
  groups: [],
  contextReferences: [],
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
  messages: [
    {
      id: 'assistant-0',
      role: 'assistant',
      timestamp: '2026/3/24 20:00:00',
      title: 'Reply',
      content: 'Existing content',
      status: 'complete',
    },
  ],
});

const makeProjects = (): ProjectRecord[] => [
  {
    id: 'project-1',
    name: 'EasyAIFlow',
    rootPath: 'X:\\AITool\\EasyAIFlow',
    dreams: [
      {
        id: 'dream-1',
        name: 'Main Streamwork',
        sessions: [makeSession()],
      },
    ],
  },
];

run('buildOptimisticSendState appends a local user message and assistant placeholder immediately', () => {
  const attachments: PendingAttachment[] = [
    {
      id: 'attachment-1',
      name: 'trace.log',
      mimeType: 'text/plain',
      size: 128,
      path: 'X:\\AITool\\EasyAIFlow\\trace.log',
    },
  ];
  const references: ContextReference[] = [
    {
      id: 'ctx-1',
      kind: 'session',
      label: 'Earlier session',
      mode: 'summary',
      sessionId: 'session-0',
    },
  ];

  const result = buildOptimisticSendState({
    projects: makeProjects(),
    sessionId: 'session-1',
    prompt: 'Investigate the slowdown',
    attachments,
    references,
    queued: false,
    now: new Date('2026-03-25T08:09:10.000Z'),
  });

  const session = result.projects[0]?.dreams[0]?.sessions[0] as SessionRecord;
  assert.equal(session.messages.length, 3);

  const userMessage = session.messages[1];
  assert.equal(userMessage.role, 'user');
  assert.equal(userMessage.content, 'Investigate the slowdown');
  assert.deepEqual(userMessage.contextReferences, references);
  assert.deepEqual(userMessage.attachments, [
    {
      id: 'attachment-1',
      name: 'trace.log',
      path: 'X:\\AITool\\EasyAIFlow\\trace.log',
      mimeType: 'text/plain',
      size: 128,
    },
  ]);

  const assistantMessage = session.messages[2];
  assert.equal(assistantMessage.role, 'assistant');
  assert.equal(assistantMessage.status, 'streaming');
  assert.equal(assistantMessage.title, 'Claude response');
  assert.equal(assistantMessage.content, '');
  assert.equal(session.preview, 'Investigate the slowdown');
  assert.equal(session.timeLabel, 'Just now');
  assert.equal(session.updatedAt, new Date('2026-03-25T08:09:10.000Z').getTime());
  assert.match(result.userMessageId, /^local-user-/);
  assert.match(result.assistantMessageId, /^local-assistant-/);
});

run('buildOptimisticSendState shows a queued placeholder when the session is already responding', () => {
  const result = buildOptimisticSendState({
    projects: makeProjects(),
    sessionId: 'session-1',
    prompt: 'Queue this follow-up',
    attachments: [],
    references: [],
    queued: true,
    now: new Date('2026-03-25T08:09:10.000Z'),
  });

  const session = result.projects[0]?.dreams[0]?.sessions[0] as SessionRecord;
  const assistantMessage = session.messages[2];
  assert.equal(assistantMessage.status, 'queued');
  assert.equal(assistantMessage.title, 'Claude queued');
  assert.match(assistantMessage.content, /Queued\./);
});

run('buildOptimisticSendState uses provider-specific placeholder copy', () => {
  const projects = makeProjects();
  const session = projects[0]?.dreams[0]?.sessions[0] as SessionRecord;
  session.provider = 'codex';
  session.model = 'gpt-5.5';

  const result = buildOptimisticSendState({
    projects,
    sessionId: 'session-1',
    prompt: 'Check the failing build',
    attachments: [],
    references: [],
    queued: false,
    provider: 'codex',
    now: new Date('2026-03-25T08:09:10.000Z'),
  });

  const updatedSession = result.projects[0]?.dreams[0]?.sessions[0] as SessionRecord;
  const assistantMessage = updatedSession.messages[2];
  assert.equal(assistantMessage.title, 'Codex response');
});

run('reconcileOptimisticSendMessages rewrites local ids without clobbering real streamed messages', () => {
  const optimistic = buildOptimisticSendState({
    projects: makeProjects(),
    sessionId: 'session-1',
    prompt: 'Check the failing build',
    attachments: [],
    references: [],
    queued: false,
    now: new Date('2026-03-25T08:09:10.000Z'),
  });

  const sessionWithRealMessages = optimistic.projects[0]?.dreams[0]?.sessions[0] as SessionRecord;
  sessionWithRealMessages.messages.push(
    {
      id: 'server-user-1',
      role: 'user',
      timestamp: '2026/3/25 08:09:11',
      title: 'User prompt',
      content: 'Check the failing build',
      status: 'complete',
    },
    {
      id: 'server-assistant-1',
      role: 'assistant',
      timestamp: '2026/3/25 08:09:11',
      title: 'Claude response',
      content: 'Final streamed answer',
      status: 'complete',
    },
  );

  const reconciled = reconcileOptimisticSendMessages({
    projects: optimistic.projects,
    sessionId: 'session-1',
    optimisticUserMessageId: optimistic.userMessageId,
    optimisticAssistantMessageId: optimistic.assistantMessageId,
    queuedUserMessageId: 'server-user-1',
    queuedAssistantMessageId: 'server-assistant-1',
  });

  const session = reconciled[0]?.dreams[0]?.sessions[0] as SessionRecord;
  assert.equal(
    session.messages.filter((message) => message.id === 'server-user-1').length,
    1,
  );
  assert.equal(
    session.messages.filter((message) => message.id === 'server-assistant-1').length,
    1,
  );
  assert.equal(
    session.messages.some((message) => message.id === optimistic.userMessageId),
    false,
  );
  assert.equal(
    session.messages.some((message) => message.id === optimistic.assistantMessageId),
    false,
  );
  assert.equal(
    session.messages.find((message) => message.id === 'server-assistant-1')?.content,
    'Final streamed answer',
  );
});
