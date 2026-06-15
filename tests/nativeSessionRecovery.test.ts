import assert from 'node:assert/strict';
import {
  mergeNativeConversationMessages,
  mergeNativeSessionIntoExisting,
  shouldRecoverSessionFromNative,
  type ParsedNativeSession,
} from '../electron/nativeSessionRecovery.ts';
import type { ConversationMessage, SessionRecord } from '../src/data/types.ts';

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
  id: overrides.id ?? 'message-1',
  role: overrides.role ?? 'assistant',
  kind: overrides.kind,
  timestamp: overrides.timestamp ?? 'now',
  title: overrides.title ?? 'Claude response',
  content: overrides.content ?? '',
  status: overrides.status ?? 'complete',
});

const makeSession = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  id: overrides.id ?? 'session-1',
  title: overrides.title ?? 'Shader',
  preview: overrides.preview ?? '这是你之前的结论，你review一下代码，看说的对比',
  timeLabel: overrides.timeLabel ?? 'Just now',
  updatedAt: overrides.updatedAt ?? 10,
  model: overrides.model ?? 'claude-opus-4-6',
  workspace: overrides.workspace ?? 'X:\\PBZ\\ProjectPBZ',
  projectId: overrides.projectId ?? 'project-1',
  projectName: overrides.projectName ?? 'ProjectPBZ',
  dreamId: overrides.dreamId ?? 'memory',
  dreamName: overrides.dreamName ?? 'Memory',
  claudeSessionId: overrides.claudeSessionId ?? 'native-1',
  groups: overrides.groups ?? [],
  contextReferences: overrides.contextReferences ?? [],
  tokenUsage: overrides.tokenUsage ?? {
    contextWindow: 0,
    used: 0,
    input: 0,
    output: 0,
    cached: 0,
    windowSource: 'unknown',
  },
  branchSnapshot: overrides.branchSnapshot ?? {
    branch: 'main',
    ahead: 0,
    behind: 0,
    dirty: false,
    changedFiles: [],
  },
  messages: overrides.messages ?? [makeMessage({ content: '', title: 'Claude response', status: 'complete' })],
});

const parsedNative: ParsedNativeSession = {
  nativeSessionId: 'native-1',
  title: 'Shader',
  preview: '## 源码验证结果汇总',
  timeLabel: '3/23 20:53',
  updatedAt: 20,
  model: 'claude-opus-4-6',
  messages: [
    makeMessage({
      id: 'assistant-final',
      content: '## 源码验证结果汇总\n\n对照引擎源码逐项校验...',
      title: '## 源码验证结果汇总',
      status: 'complete',
    }),
  ],
};

run('shouldRecoverSessionFromNative detects an empty completed assistant placeholder', () => {
  const existing = makeSession();

  assert.equal(shouldRecoverSessionFromNative(existing, parsedNative), true);
});

run('mergeNativeSessionIntoExisting replaces broken messages but keeps local ownership fields', () => {
  const existing = makeSession();
  const recovered = mergeNativeSessionIntoExisting(existing, parsedNative);

  assert.equal(recovered.id, 'session-1');
  assert.equal(recovered.dreamId, 'memory');
  assert.equal(recovered.dreamName, 'Memory');
  assert.equal(recovered.projectId, 'project-1');
  assert.equal(recovered.projectName, 'ProjectPBZ');
  assert.equal(recovered.preview, '## 源码验证结果汇总');
  assert.equal(recovered.messages.length, 1);
  assert.equal(recovered.messages[0]?.content.startsWith('## 源码验证结果汇总'), true);
});

run('mergeNativeConversationMessages appends recovered fresh-session turns without duplicating context', () => {
  const existing = [
    makeMessage({
      id: 'old-user',
      role: 'user',
      title: 'hi',
      content: 'hi',
    }),
    makeMessage({
      id: 'old-assistant',
      title: '你好',
      content: '你好',
    }),
  ];
  const recoveryPrompt = [
    'EasyAIFlow is starting a fresh native Claude conversation instead of resuming old-native.',
    'Reason: Claude no longer has that local transcript.',
    'The EasyAIFlow transcript before the current message is provided below as recovery context.',
    'Use it only as supporting context; do not claim the native Claude conversation was recovered.',
    '',
    'Session: FogBlink',
    'Transcript:',
    '[USER | 6/14 15:47 | hi]',
    'hi',
    '',
    'Current user message:',
    '',
    '你看现在还缺什么',
  ].join('\n');
  const parsed = [
    makeMessage({
      id: 'native-user',
      role: 'user',
      title: 'EasyAIFlow is starting a fresh native Claude',
      content: recoveryPrompt,
    }),
    makeMessage({
      id: 'native-assistant',
      title: '还缺一次完整构建验证。',
      content: '还缺一次完整构建验证。',
    }),
  ];

  const merged = mergeNativeConversationMessages(existing, parsed);
  const mergedAgain = mergeNativeConversationMessages(merged, parsed);

  assert.equal(merged.length, 4);
  assert.equal(merged[2]?.content, '你看现在还缺什么');
  assert.equal(merged[2]?.title, '你看现在还缺什么');
  assert.equal(merged.some((message) => message.content.includes('Session: FogBlink')), false);
  assert.deepEqual(
    mergedAgain.map((message) => message.content),
    merged.map((message) => message.content),
  );
});

run('mergeNativeConversationMessages replaces previously imported raw recovery prompts', () => {
  const recoveryPrompt = [
    'EasyAIFlow is starting a fresh native Claude conversation instead of resuming old-native.',
    'Reason: Claude no longer has that local transcript.',
    '',
    'Current user message:',
    '',
    '你改了然后运行编辑器试试',
  ].join('\n');
  const pollutedExisting = [
    makeMessage({
      id: 'polluted-user',
      role: 'user',
      title: 'EasyAIFlow is starting a fresh native Claude',
      content: recoveryPrompt,
    }),
    makeMessage({
      id: 'duplicated-tool',
      role: 'system',
      kind: 'tool_use',
      title: 'Edit',
      content: 'Edit(D:\\PBZ\\PBZGitEngine\\Engine\\Source\\Runtime\\D3D12RHI\\Private\\D3D12BindlessDescriptors.cpp)',
      status: 'success',
    }),
    makeMessage({
      id: 'duplicated-tool-2',
      role: 'system',
      kind: 'tool_use',
      title: 'Edit',
      content: 'Edit(D:\\PBZ\\PBZGitEngine\\Engine\\Source\\Runtime\\D3D12RHI\\Private\\D3D12BindlessDescriptors.cpp)',
      status: 'success',
    }),
  ];
  const parsed = [
    makeMessage({
      id: 'native-user',
      role: 'user',
      title: 'EasyAIFlow is starting a fresh native Claude',
      content: recoveryPrompt,
    }),
    makeMessage({
      id: 'native-assistant',
      title: '我先恢复上下文',
      content: '我先恢复上下文：读一下记忆文件和当前代码改动状态。',
    }),
  ];

  const merged = mergeNativeConversationMessages(pollutedExisting, parsed);

  assert.equal(merged.length, 2);
  assert.equal(merged[0]?.content, '你改了然后运行编辑器试试');
  assert.equal(merged.some((message) => message.content.startsWith('EasyAIFlow is starting')), false);
  assert.equal(merged.some((message) => message.title === 'Edit'), false);
});

run('mergeNativeConversationMessages does not reappend normalized recovery turns when statuses differ', () => {
  const recoveryPrompt = [
    'EasyAIFlow is starting a fresh native Claude conversation instead of resuming old-native.',
    'Reason: Claude no longer has that local transcript.',
    '',
    'Current user message:',
    '',
    '你改了然后运行编辑器试试',
  ].join('\n');
  const existing = [
    makeMessage({
      id: 'existing-user',
      role: 'user',
      title: '你改了然后运行编辑器试试',
      content: '你改了然后运行编辑器试试',
      status: 'complete',
    }),
    makeMessage({
      id: 'existing-tool',
      role: 'system',
      kind: 'tool_use',
      title: 'Edit',
      content: 'Edit(D:\\PBZ\\PBZGitEngine\\Engine\\Source\\Runtime\\D3D12RHI\\Private\\D3D12BindlessDescriptors.cpp)',
      status: 'success',
    }),
  ];
  const parsed = [
    makeMessage({
      id: 'native-user',
      role: 'user',
      title: 'EasyAIFlow is starting a fresh native Claude',
      content: recoveryPrompt,
      status: undefined,
    }),
    makeMessage({
      id: 'native-tool',
      role: 'system',
      kind: 'tool_use',
      title: 'Edit',
      content: 'Edit(D:\\PBZ\\PBZGitEngine\\Engine\\Source\\Runtime\\D3D12RHI\\Private\\D3D12BindlessDescriptors.cpp)',
      status: 'running',
    }),
  ];

  const merged = mergeNativeConversationMessages(existing, parsed);

  assert.deepEqual(
    merged.map((message) => message.content),
    existing.map((message) => message.content),
  );
});

run('mergeNativeConversationMessages compacts repeated normalized recovery imports', () => {
  const recoveryPrompt = [
    'EasyAIFlow is starting a fresh native Claude conversation instead of resuming old-native.',
    'Reason: Claude no longer has that local transcript.',
    '',
    'Current user message:',
    '',
    '你改了然后运行编辑器试试',
  ].join('\n');
  const parsed = [
    makeMessage({
      id: 'native-user',
      role: 'user',
      title: 'EasyAIFlow is starting a fresh native Claude',
      content: recoveryPrompt,
    }),
    ...Array.from({ length: 20 }, (_, index) =>
      makeMessage({
        id: `native-tool-${index}`,
        role: 'system',
        kind: 'tool_use',
        title: 'Edit',
        content: `Edit(D:\\PBZ\\File${index}.cpp)`,
        status: 'running',
      }),
    ),
  ];
  const normalizedOnce = mergeNativeConversationMessages([], parsed);
  const pollutedExisting = [
    ...normalizedOnce,
    ...normalizedOnce.map((message, index) => ({
      ...message,
      id: `duplicate-${index}`,
      status: message.status === 'running' ? 'success' as const : message.status,
    })),
    ...normalizedOnce.map((message, index) => ({
      ...message,
      id: `duplicate-2-${index}`,
    })),
  ];

  const merged = mergeNativeConversationMessages(pollutedExisting, parsed);

  assert.equal(merged.length, normalizedOnce.length);
  assert.equal(merged[0]?.content, '你改了然后运行编辑器试试');
  assert.deepEqual(
    merged.map((message) => message.content),
    normalizedOnce.map((message) => message.content),
  );
});

run('shouldRecoverSessionFromNative ignores cleanup-only assistant follow-ups when comparing final answers', () => {
  const existing = makeSession({
    preview: '(Background task cleaned up — no action needed.)',
    messages: [
      makeMessage({
        id: 'assistant-cleanup',
        content: '(Background task cleaned up — no action needed.)',
        title: '(Background task cleaned up — no action needed.)',
      }),
    ],
  });

  const parsed: ParsedNativeSession = {
    ...parsedNative,
    messages: [
      makeMessage({
        id: 'assistant-answer',
        content: '## Lumen 三种 Gather 对半透明的处理\n\n核心结论：半透明 GI 与 Gather 方法基本解耦。',
        title: '## Lumen 三种 Gather 对半透明的处理',
      }),
      makeMessage({
        id: 'assistant-cleanup-native',
        content: '(Background task cleaned up — no action needed.)',
        title: '(Background task cleaned up — no action needed.)',
      }),
    ],
    preview: '## Lumen 三种 Gather 对半透明的处理',
  };

  assert.equal(shouldRecoverSessionFromNative(existing, parsed), true);
});

run('shouldRecoverSessionFromNative detects missing intermediate assistant replies', () => {
  const existing = makeSession({
    messages: [
      makeMessage({
        id: 'user-1',
        role: 'user',
        title: 'Prompt',
        content: 'Analyze the two captures.',
      }),
      makeMessage({
        id: 'assistant-1',
        content: 'I opened the captures and started comparing counters.',
        title: 'I opened the captures and started comparin',
      }),
      makeMessage({
        id: 'user-2',
        role: 'user',
        title: '1',
        content: '1',
      }),
      makeMessage({
        id: 'assistant-2',
        content: 'Final answer after the follow-up.',
        title: 'Final answer after the follow-up.',
      }),
    ],
  });

  const parsed: ParsedNativeSession = {
    ...parsedNative,
    messages: [
      makeMessage({
        id: 'user-1',
        role: 'user',
        title: 'Prompt',
        content: 'Analyze the two captures.',
      }),
      makeMessage({
        id: 'assistant-1',
        content: 'I opened the captures and started comparing counters.',
        title: 'I opened the captures and started comparin',
      }),
      makeMessage({
        id: 'assistant-mid',
        content: 'The first comparison is done; now I am checking the invocation diffs.',
        title: 'The first comparison is done; now I am che',
      }),
      makeMessage({
        id: 'user-2',
        role: 'user',
        title: '1',
        content: '1',
      }),
      makeMessage({
        id: 'assistant-2',
        content: 'Final answer after the follow-up.',
        title: 'Final answer after the follow-up.',
      }),
    ],
  };

  assert.equal(shouldRecoverSessionFromNative(existing, parsed), true);
});
