import assert from 'node:assert/strict';
import {
  hydrateSessionRecordInProjects,
  mergeProjectSnapshots,
  mergeProjectSnapshotsAndHydrateSession,
} from '../src/data/projectSnapshots.ts';
import type {
  BranchSnapshot,
  ConversationMessage,
  ProjectRecord,
  SessionRecord,
  TokenUsage,
} from '../src/data/types.ts';

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

const tokenUsage: TokenUsage = {
  contextWindow: 0,
  used: 0,
  input: 0,
  output: 0,
  cached: 0,
  windowSource: 'unknown',
};

const branchSnapshot: BranchSnapshot = {
  branch: 'main',
  tracking: undefined,
  ahead: 0,
  behind: 0,
  dirty: false,
  changedFiles: [],
};

const makeMessage = (id: string, content: string): ConversationMessage => ({
  id,
  role: id.startsWith('user') || id.startsWith('local-user') ? 'user' : 'assistant',
  timestamp: '2026/4/23 21:30:00',
  title: 'message',
  content,
  status: 'complete',
});

const makeSession = (
  id: string,
  overrides: Partial<SessionRecord> = {},
): SessionRecord => ({
  id,
  title: `Session ${id}`,
  preview: overrides.preview ?? '',
  timeLabel: overrides.timeLabel ?? 'Just now',
  updatedAt: overrides.updatedAt ?? 1,
  provider: Object.prototype.hasOwnProperty.call(overrides, 'provider') ? overrides.provider : 'claude',
  model: overrides.model ?? 'opus[1m]',
  workspace: overrides.workspace ?? 'D:\\AIAgent\\EasyAIFlow',
  projectId: overrides.projectId ?? 'project-1',
  projectName: overrides.projectName ?? 'EasyAIFlow',
  dreamId: overrides.dreamId ?? 'dream-1',
  dreamName: overrides.dreamName ?? 'Main',
  claudeSessionId: overrides.claudeSessionId,
  codexThreadId: overrides.codexThreadId,
  sessionKind: overrides.sessionKind ?? 'standard',
  hidden: overrides.hidden ?? false,
  instructionPrompt: overrides.instructionPrompt,
  group: overrides.group,
  groups: overrides.groups ?? [],
  contextReferences: overrides.contextReferences ?? [],
  tokenUsage: overrides.tokenUsage ?? tokenUsage,
  branchSnapshot: overrides.branchSnapshot ?? branchSnapshot,
  messagesLoaded: overrides.messagesLoaded,
  messages: overrides.messages ?? [],
});

const makeProjects = (...sessions: SessionRecord[]): ProjectRecord[] => [
  {
    id: 'project-1',
    name: 'EasyAIFlow',
    rootPath: 'D:\\AIAgent\\EasyAIFlow',
    dreams: [
      {
        id: 'dream-1',
        name: 'Main',
        sessions,
      },
    ],
  },
];

run('mergeProjectSnapshots keeps newer live session data when an older full snapshot arrives', () => {
  const currentProjects = makeProjects(
    makeSession('single', {
      updatedAt: 200,
      preview: 'single-new',
      messages: [makeMessage('assistant-single', 'single newest reply')],
    }),
    makeSession('group', {
      updatedAt: 300,
      preview: 'group-new',
      sessionKind: 'group',
      provider: undefined,
      model: '',
      messages: [makeMessage('assistant-group', 'group newest reply')],
    }),
  );

  const incomingProjects = makeProjects(
    makeSession('single', {
      updatedAt: 100,
      preview: 'single-old',
      messages: [makeMessage('assistant-single-old', 'single stale reply')],
    }),
    makeSession('group', {
      updatedAt: 150,
      preview: 'group-old',
      sessionKind: 'group',
      provider: undefined,
      model: '',
      messages: [makeMessage('assistant-group-old', 'group stale reply')],
    }),
  );

  const merged = mergeProjectSnapshots(currentProjects, incomingProjects);
  const sessions = merged[0]?.dreams[0]?.sessions as SessionRecord[];

  assert.equal(sessions[0]?.preview, 'single-new');
  assert.equal(sessions[0]?.messages[0]?.content, 'single newest reply');
  assert.equal(sessions[1]?.preview, 'group-new');
  assert.equal(sessions[1]?.messages[0]?.content, 'group newest reply');
});

run('mergeProjectSnapshots keeps newer optimistic/live session data when a stale snapshot arrives', () => {
  const currentProjects = makeProjects(
    makeSession('single', {
      updatedAt: 500,
      preview: 'draft',
      messages: [
        makeMessage('local-user-1', 'question'),
        makeMessage('local-assistant-1', 'Queued. Claude will start this message after the current run completes.'),
      ],
    }),
  );

  const incomingProjects = makeProjects(
    makeSession('single', {
      updatedAt: 490,
      preview: 'question',
      messages: [
        makeMessage('user-real-1', 'question'),
        makeMessage('assistant-real-1', ''),
      ],
    }),
  );

  const merged = mergeProjectSnapshots(currentProjects, incomingProjects);
  const session = merged[0]?.dreams[0]?.sessions[0] as SessionRecord;

  assert.equal(session.messages[0]?.id, 'local-user-1');
  assert.equal(session.messages[1]?.id, 'local-assistant-1');
});

run('mergeProjectSnapshots preserves loaded history when bootstrap only returns summaries', () => {
  const currentProjects = makeProjects(
    makeSession('single', {
      updatedAt: 200,
      messagesLoaded: true,
      messages: [makeMessage('assistant-1', 'existing history')],
    }),
  );

  const incomingProjects = makeProjects(
    makeSession('single', {
      updatedAt: 210,
      preview: 'summary only',
      messagesLoaded: false,
      messages: [],
    }),
  );

  const merged = mergeProjectSnapshots(currentProjects, incomingProjects);
  const session = merged[0]?.dreams[0]?.sessions[0] as SessionRecord;

  assert.equal(session.preview, 'summary only');
  assert.equal(session.messagesLoaded, true);
  assert.equal(session.messages[0]?.content, 'existing history');
});

run('mergeProjectSnapshotsAndHydrateSession uses the full created session over the lightweight snapshot', () => {
  const currentProjects = makeProjects(
    makeSession('old', {
      updatedAt: 200,
      messagesLoaded: true,
      messages: [makeMessage('assistant-old', 'old session history')],
    }),
  );
  const createdSession = {
    ...makeSession('new', {
      updatedAt: 300,
      messages: [],
    }),
    title: 'Followup',
  };

  const incomingProjects = makeProjects(
    makeSession('new', {
      updatedAt: 300,
      messagesLoaded: false,
      messages: [],
    }),
    makeSession('old', {
      updatedAt: 210,
      messagesLoaded: false,
      messages: [],
    }),
  );

  const merged = mergeProjectSnapshotsAndHydrateSession(
    currentProjects,
    incomingProjects,
    createdSession,
  );
  const sessions = merged[0]?.dreams[0]?.sessions as SessionRecord[];

  assert.equal(sessions[0]?.id, 'new');
  assert.equal(sessions[0]?.title, 'Followup');
  assert.equal(sessions[0]?.messagesLoaded, true);
  assert.deepEqual(sessions[0]?.messages, []);
  assert.equal(sessions[1]?.id, 'old');
  assert.equal(sessions[1]?.messages[0]?.content, 'old session history');
});

run('hydrateSessionRecordInProjects inserts the full session if the snapshot does not contain it yet', () => {
  const currentProjects = makeProjects(
    makeSession('old', {
      messages: [makeMessage('assistant-old', 'old session history')],
    }),
  );
  const createdSession = {
    ...makeSession('new', {
      messages: [],
    }),
    title: 'Inserted Session',
  };

  const merged = hydrateSessionRecordInProjects(currentProjects, createdSession);
  const sessions = merged[0]?.dreams[0]?.sessions as SessionRecord[];

  assert.equal(sessions[0]?.id, 'new');
  assert.equal(sessions[0]?.title, 'Inserted Session');
  assert.equal(sessions[0]?.messagesLoaded, true);
  assert.deepEqual(sessions[0]?.messages, []);
  assert.equal(sessions[1]?.id, 'old');
  assert.equal(sessions[1]?.messages[0]?.content, 'old session history');
});

run('mergeProjectSnapshots applies stale group conversion metadata and sequenced messages', () => {
  const currentProjects = makeProjects(
    makeSession('room', {
      updatedAt: 500,
      provider: 'claude',
      sessionKind: 'standard',
      messages: [
        makeMessage('user-existing', 'before group mode'),
        makeMessage('user-new', '@codex 看一下'),
      ],
    }),
  );

  const incomingProjects = makeProjects(
    makeSession('room', {
      updatedAt: 490,
      provider: undefined,
      model: '',
      sessionKind: 'group',
      group: {
        kind: 'room',
        nextMessageSeq: 4,
        participants: [
          {
            id: 'claude',
            label: 'Claude',
            provider: 'claude',
            backingSessionId: 'member-claude',
            enabled: true,
            lastAppliedRoomSeq: 1,
          },
          {
            id: 'codex',
            label: 'Codex',
            provider: 'codex',
            backingSessionId: 'member-codex',
            enabled: true,
            lastAppliedRoomSeq: 0,
          },
        ],
      },
      messages: [
        {
          ...makeMessage('user-existing', 'before group mode'),
          seq: 1,
          speakerId: 'user',
          speakerLabel: 'You',
        },
        {
          ...makeMessage('user-new', '@codex 看一下'),
          seq: 2,
          speakerId: 'user',
          speakerLabel: 'You',
          targetParticipantIds: ['codex'],
        },
        {
          ...makeMessage('assistant-codex', ''),
          seq: 3,
          speakerId: 'codex',
          speakerLabel: 'Codex',
          provider: 'codex',
          sourceSessionId: 'member-codex',
          status: 'streaming',
        },
      ],
    }),
  );

  const merged = mergeProjectSnapshots(currentProjects, incomingProjects);
  const session = merged[0]?.dreams[0]?.sessions[0] as SessionRecord;

  assert.equal(session.sessionKind, 'group');
  assert.equal(session.provider, undefined);
  assert.equal(session.group?.kind, 'room');
  assert.equal(session.messages.length, 3);
  assert.equal(session.messages[1]?.seq, 2);
  assert.equal(session.messages[1]?.targetParticipantIds?.[0], 'codex');
  assert.equal(session.messages[2]?.id, 'assistant-codex');
  assert.equal(session.messages[2]?.speakerLabel, 'Codex');
});

run('mergeProjectSnapshots keeps live group completion over stale queued snapshot', () => {
  const group = {
    kind: 'room' as const,
    nextMessageSeq: 3,
    participants: [
      {
        id: 'codex' as const,
        label: 'Codex',
        provider: 'codex' as const,
        backingSessionId: 'member-codex',
        enabled: true,
        lastAppliedRoomSeq: 0,
      },
    ],
  };
  const currentProjects = makeProjects(
    makeSession('room', {
      updatedAt: 500,
      provider: undefined,
      model: '',
      sessionKind: 'group',
      group,
      messages: [
        {
          ...makeMessage('assistant-codex', '已经修好了'),
          seq: 2,
          speakerId: 'codex',
          speakerLabel: 'Codex',
          provider: 'codex',
          status: 'complete',
        },
      ],
    }),
  );

  const incomingProjects = makeProjects(
    makeSession('room', {
      updatedAt: 490,
      provider: undefined,
      model: '',
      sessionKind: 'group',
      group,
      messages: [
        {
          ...makeMessage('assistant-codex', ''),
          seq: 2,
          speakerId: 'codex',
          speakerLabel: 'Codex',
          provider: 'codex',
          status: 'streaming',
        },
      ],
    }),
  );

  const merged = mergeProjectSnapshots(currentProjects, incomingProjects);
  const session = merged[0]?.dreams[0]?.sessions[0] as SessionRecord;

  assert.equal(session.messages[0]?.content, '已经修好了');
  assert.equal(session.messages[0]?.status, 'complete');
});
