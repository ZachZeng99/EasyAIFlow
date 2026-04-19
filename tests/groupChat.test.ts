import assert from 'node:assert/strict';
import {
  buildRoomSyncPrompt,
  buildCodexRoomChatPrompt,
  ignoreMissingSessionError,
  resolveMirroredAssistantRoomMessageId,
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

run('buildRoomSyncPrompt tells Claude to either answer directly or do the requested work', () => {
  const prompt = buildRoomSyncPrompt(
    makeRoomSession(),
    makeParticipant(),
    [
      {
        id: 'message-1',
        role: 'user',
        seq: 1,
        timestamp: '4/7 09:42',
        title: '@codex 看一下这个问题',
        content: '@codex 看一下这个问题',
        speakerId: 'user',
        speakerLabel: 'You',
        status: 'complete',
        targetParticipantIds: ['codex'],
      },
    ],
    1,
  );

  assert.match(prompt, /<task>/);
  assert.match(prompt, /You are Codex in a shared chat room about the current workspace\./);
  assert.match(prompt, /Decide whether TARGET_MESSAGE is asking for:/);
  assert.match(prompt, /If it is \(2\), do the work before replying\./);
  assert.match(prompt, /Do not stop at a plan or promise\./);
  assert.match(prompt, /TARGET_MESSAGE:/);
  assert.match(prompt, /#1 \[You\] \[message status=complete\] title="@codex 看一下这个问题"/);
  assert.match(prompt, /ROOM_CONTEXT through message #1:/);
  assert.match(prompt, /<compact_output_contract>/);
  assert.match(prompt, /Do not say you will do work later if you have not done it in this turn\./);
  assert.match(prompt, /<verification_loop>/);
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

run('buildCodexRoomChatPrompt tells Codex to either answer directly or do the requested work', () => {
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
  assert.match(prompt, /Decide whether TARGET_MESSAGE is asking for:/);
  assert.match(prompt, /If it is \(2\), do the work before replying\./);
  assert.match(prompt, /Do not stop at a plan or promise\./);
  assert.match(prompt, /If it is only \(1\), answer directly\./);
  assert.match(prompt, /TARGET_MESSAGE:/);
  assert.match(prompt, /#2 \[You\] \[message status=complete\] title="@codex claude说的对吗"/);
  assert.match(prompt, /LATEST_PARTICIPANT_REPLY:/);
  assert.match(prompt, /#1 \[Claude\] \[message status=complete\] title="Claude response"/);
  assert.match(
    prompt,
    /If TARGET_MESSAGE asks whether another participant's reply is correct, use LATEST_PARTICIPANT_REPLY and Chat context directly\./,
  );
  assert.match(prompt, /Do not ask the user to repeat content that is already shown below\./);
  assert.match(prompt, /Chat context:/);
  assert.match(prompt, /Claude: 集成Claude CLI的本地AI编程桌面客户端。/);
  assert.match(prompt, /You: @codex claude说的对吗/);
  assert.match(prompt, /<compact_output_contract>/);
  assert.match(prompt, /Do not say you will do work later if you have not done it in this turn\./);
  assert.match(prompt, /<verification_loop>/);
});

run('buildCodexRoomChatPrompt treats missing follow-through complaints as active work requests', () => {
  const prompt = buildCodexRoomChatPrompt(
    makeParticipant(),
    [
      {
        id: 'codex-1',
        role: 'assistant',
        seq: 1,
        timestamp: '4/7 09:43',
        title: 'Codex response',
        content: '刚才停在 review 结论上了，没把修复进度继续往群里回出来。\n\n现在继续收这 2 个点，不再岔开：\n1. app-server 通知过滤。\n2. 首条 @mention 升级群聊。',
        speakerId: 'codex',
        speakerLabel: 'Codex',
        provider: 'codex',
        status: 'complete',
      },
      {
        id: 'message-2',
        role: 'user',
        seq: 2,
        timestamp: '4/7 09:44',
        title: '@codex 刚才你也这么说的，但是没有后续了，你查一下怎么回事',
        content: '@codex 刚才你也这么说的，但是没有后续了，你查一下怎么回事',
        speakerId: 'user',
        speakerLabel: 'You',
        status: 'complete',
        targetParticipantIds: ['codex'],
      },
    ],
  );

  assert.match(
    prompt,
    /If the user is calling out missing follow-through on work you already said you would do, treat that as \(2\): continue the work and return concrete results\./,
  );
  assert.match(prompt, /Codex: 刚才停在 review 结论上了/);
  assert.match(prompt, /You: @codex 刚才你也这么说的，但是没有后续了，你查一下怎么回事/);
});

run('buildRoomSyncPrompt keeps Claude evaluation turns grounded in existing room context', () => {
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
  assert.match(prompt, /Do not ask the user to repeat content that is already shown in ROOM_CONTEXT\./);
  assert.match(prompt, /If it is only \(1\), answer directly\./);
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

run('resolveGroupTargets parses @mentions after Chinese characters and punctuation', () => {
  const participants = makeRoomSession().group?.kind === 'room' ? makeRoomSession().group.participants : [];
  assert.deepEqual(
    resolveGroupTargets('你好@codex', participants, []),
    ['codex'],
  );
  assert.deepEqual(
    resolveGroupTargets('，@all 看看', participants, []),
    ['claude', 'codex'],
  );
  assert.deepEqual(
    resolveGroupTargets('测试！@claude 检查一下', participants, []),
    ['claude'],
  );
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

run('resolveMirroredAssistantRoomMessageId ignores foreign events once the backing assistant id is known', () => {
  const room = makeRoomSession([
    {
      id: 'assistant-old',
      role: 'assistant',
      timestamp: '4/7 09:43',
      title: 'Claude response',
      content: '',
      speakerId: 'claude',
      speakerLabel: 'Claude',
      provider: 'claude',
      sourceSessionId: 'member-claude',
      status: 'streaming',
    },
    {
      id: 'assistant-new',
      role: 'assistant',
      timestamp: '4/7 09:44',
      title: 'Claude response',
      content: '',
      speakerId: 'claude',
      speakerLabel: 'Claude',
      provider: 'claude',
      sourceSessionId: 'member-claude',
      status: 'streaming',
    },
  ]);

  const resolved = resolveMirroredAssistantRoomMessageId(
    {
      roomSessionId: room.id,
      backingSessionId: 'member-claude',
      participant: makeParticipant({ id: 'claude', label: 'Claude', provider: 'claude', backingSessionId: 'member-claude' }),
      roomAssistantMessageId: 'assistant-new',
      backingAssistantMessageId: 'backing-new',
    },
    room,
    'backing-old',
  );

  assert.equal(resolved, null);
});

run('resolveMirroredAssistantRoomMessageId falls back to the latest pending placeholder before the backing assistant id is known', () => {
  const room = makeRoomSession([
    {
      id: 'assistant-old',
      role: 'assistant',
      timestamp: '4/7 09:43',
      title: 'Claude response',
      content: '',
      speakerId: 'claude',
      speakerLabel: 'Claude',
      provider: 'claude',
      sourceSessionId: 'member-claude',
      status: 'complete',
    },
    {
      id: 'assistant-new',
      role: 'assistant',
      timestamp: '4/7 09:44',
      title: 'Claude response',
      content: '',
      speakerId: 'claude',
      speakerLabel: 'Claude',
      provider: 'claude',
      sourceSessionId: 'member-claude',
      status: 'streaming',
    },
  ]);

  const resolved = resolveMirroredAssistantRoomMessageId(
    {
      roomSessionId: room.id,
      backingSessionId: 'member-claude',
      participant: makeParticipant({ id: 'claude', label: 'Claude', provider: 'claude', backingSessionId: 'member-claude' }),
      roomAssistantMessageId: 'assistant-new',
    },
    room,
    'backing-unknown',
  );

  assert.equal(resolved, 'assistant-new');
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
