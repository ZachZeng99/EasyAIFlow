import assert from 'node:assert/strict';
import {
  buildRoomSyncPrompt,
  buildCodexRoomChatPrompt,
  ignoreMissingSessionError,
} from '../backend/groupChat.ts';
import { resolveGroupTargets } from '../src/data/groupChat.ts';
import type { ConversationMessage, GroupParticipant, SessionRecord } from '../src/data/types.ts';

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

const runAsync = async (name: string, fn: () => Promise<void>) => {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

const makeParticipant = (overrides: Partial<GroupParticipant> = {}): GroupParticipant => ({
  id: overrides.id ?? 'codex',
  label: overrides.label ?? 'Codex',
  provider: overrides.provider ?? 'codex',
  backingSessionId: overrides.backingSessionId ?? 'member-1',
  enabled: overrides.enabled ?? true,
  model: overrides.model ?? 'gpt-5.4',
  lastAppliedRoomSeq: overrides.lastAppliedRoomSeq ?? 0,
});

const makeRoomSession = (messages: ConversationMessage[] = []): SessionRecord => ({
  id: 'room-1',
  title: 'Group room',
  preview: 'Preview',
  timeLabel: 'Just now',
  updatedAt: 1,
  provider: undefined,
  model: '',
  workspace: 'D:\\AIAgent\\EasyAIFlow-eaf_codex',
  projectId: 'project-1',
  projectName: 'EasyAIFlow',
  dreamId: 'dream-1',
  dreamName: 'Main Streamwork',
  claudeSessionId: undefined,
  codexThreadId: undefined,
  sessionKind: 'group',
  hidden: false,
  instructionPrompt: undefined,
  group: {
    kind: 'room',
    nextMessageSeq: 2,
    participants: [
      makeParticipant({ id: 'claude', label: 'Claude', provider: 'claude', backingSessionId: 'member-claude', model: 'opus[1m]' }),
      makeParticipant(),
    ],
  },
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
    tracking: undefined,
    ahead: 0,
    behind: 0,
    dirty: false,
    changedFiles: [],
  },
  messages,
});

run('buildRoomSyncPrompt keeps only the minimal room prompt structure', () => {
  const prompt = buildRoomSyncPrompt(
    makeRoomSession(),
    makeParticipant(),
    [
      {
        id: 'message-1',
        role: 'user',
        seq: 1,
        timestamp: '4/7 09:42',
        title: '@codex hi',
        content: '@codex hi',
        speakerId: 'user',
        speakerLabel: 'You',
        status: 'complete',
        targetParticipantIds: ['codex'],
      },
    ],
    1,
  );

  assert.match(prompt, /You are Codex in a shared chat room\./);
  assert.match(prompt, /Write Codex's next reply to TARGET_MESSAGE\./);
  assert.match(prompt, /TARGET_MESSAGE:/);
  assert.match(prompt, /#1 \[You\] \[message status=complete\] title="@codex hi"/);
  assert.match(prompt, /ROOM_CONTEXT through message #1:/);
  assert.match(prompt, /Reply as Codex:/);
  assert.doesNotMatch(prompt, /Requirements:/);
  assert.doesNotMatch(prompt, /Do not /);
});

run('buildCodexRoomChatPrompt uses greeting format for simple greetings', () => {
  const prompt = buildCodexRoomChatPrompt(
    makeParticipant(),
    [
      {
        id: 'message-1',
        role: 'user',
        seq: 1,
        timestamp: '4/7 09:42',
        title: '@codex hi',
        content: '@codex hi',
        speakerId: 'user',
        speakerLabel: 'You',
        status: 'complete',
        targetParticipantIds: ['codex'],
      },
    ],
  );

  assert.match(prompt, /<task>/);
  assert.match(prompt, /greeted the group chat/);
  assert.match(prompt, /<\/task>/);
  assert.match(prompt, /<compact_output_contract>/);
  assert.match(prompt, /short greeting/);
  assert.doesNotMatch(prompt, /<verification_loop>/);
  assert.match(prompt, /You: @codex hi/);
});

run('buildCodexRoomChatPrompt uses assessment format for questions with context', () => {
  const prompt = buildCodexRoomChatPrompt(
    makeParticipant(),
    [
      {
        id: 'claude-1',
        role: 'assistant',
        seq: 1,
        timestamp: '4/7 09:43',
        title: 'Claude response',
        content: '集成Claude CLI的本地AI编程桌面客户端。',
        speakerId: 'claude',
        speakerLabel: 'Claude',
        provider: 'claude',
        status: 'complete',
      },
      {
        id: 'message-2',
        role: 'user',
        seq: 2,
        timestamp: '4/7 09:44',
        title: '@codex claude说的对吗',
        content: '@codex claude说的对吗',
        speakerId: 'user',
        speakerLabel: 'You',
        status: 'complete',
        targetParticipantIds: ['codex'],
      },
    ],
  );

  assert.match(prompt, /<task>/);
  assert.match(prompt, /asked a question in a group chat/);
  assert.match(prompt, /Chat context:/);
  assert.match(prompt, /Claude: 集成Claude CLI的本地AI编程桌面客户端。/);
  assert.match(prompt, /You: @codex claude说的对吗/);
  assert.match(prompt, /<compact_output_contract>/);
  assert.match(prompt, /<verification_loop>/);
});

run('buildRoomSyncPrompt does not add special-case guidance for Claude evaluation turns', () => {
  const prompt = buildRoomSyncPrompt(
    makeRoomSession(),
    makeParticipant(),
    [
      {
        id: 'claude-1',
        role: 'assistant',
        seq: 1,
        timestamp: '4/7 09:43',
        title: 'Claude response',
        content: 'ProjectPBZ 是一个基于自定义 Unreal Engine 5 引擎分支开发的项目。',
        speakerId: 'claude',
        speakerLabel: 'Claude',
        provider: 'claude',
        status: 'complete',
      },
      {
        id: 'message-2',
        role: 'user',
        seq: 2,
        timestamp: '4/7 09:44',
        title: '@codex claude说的对吗',
        content: '@codex claude说的对吗',
        speakerId: 'user',
        speakerLabel: 'You',
        status: 'complete',
        targetParticipantIds: ['codex'],
      },
    ],
    2,
  );

  assert.match(prompt, /Participants: Claude, Codex\./);
  assert.match(prompt, /#1 \[Claude\] \[message status=complete\] title="Claude response"/);
  assert.doesNotMatch(prompt, /summarize or judge what Claude just said/i);
  assert.doesNotMatch(prompt, /Use Claude's latest message from the transcript directly\./);
});

run('resolveGroupTargets defaults to the last successful responder when the user omits mentions', () => {
  const targets = resolveGroupTargets(
    '继续往下说',
    makeRoomSession().group?.kind === 'room' ? makeRoomSession().group.participants : [],
    [
      {
        id: 'codex-1',
        role: 'assistant',
        seq: 1,
        timestamp: '4/7 09:43',
        title: 'Codex response',
        content: '先检查 groupChat.ts。',
        speakerId: 'codex',
        speakerLabel: 'Codex',
        provider: 'codex',
        status: 'complete',
      },
      {
        id: 'claude-1',
        role: 'assistant',
        seq: 2,
        timestamp: '4/7 09:44',
        title: 'Claude error',
        content: 'Request failed.',
        speakerId: 'claude',
        speakerLabel: 'Claude',
        provider: 'claude',
        status: 'error',
      },
    ],
  );

  assert.deepEqual(targets, ['codex']);
});

run('resolveGroupTargets keeps explicit mentions instead of falling back to the last responder', () => {
  const targets = resolveGroupTargets(
    '@claude 你继续',
    makeRoomSession().group?.kind === 'room' ? makeRoomSession().group.participants : [],
    [
      {
        id: 'codex-1',
        role: 'assistant',
        seq: 1,
        timestamp: '4/7 09:43',
        title: 'Codex response',
        content: '先检查 groupChat.ts。',
        speakerId: 'codex',
        speakerLabel: 'Codex',
        provider: 'codex',
        status: 'complete',
      },
    ],
  );

  assert.deepEqual(targets, ['claude']);
});

await runAsync('ignoreMissingSessionError swallows missing session failures', async () => {
  const result = await ignoreMissingSessionError(async () => {
    throw new Error('Session not found.');
  });

  assert.equal(result, null);
});

await runAsync('ignoreMissingSessionError preserves non-session failures', async () => {
  await assert.rejects(
    ignoreMissingSessionError(async () => {
      throw new Error('Boom');
    }),
    /Boom/,
  );
});
