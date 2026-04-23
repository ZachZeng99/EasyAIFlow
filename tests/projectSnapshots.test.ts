import assert from 'node:assert/strict';
import { mergeProjectSnapshots } from '../src/data/projectSnapshots.ts';
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
  provider: overrides.provider ?? 'claude',
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
