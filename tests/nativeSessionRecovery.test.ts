import assert from 'node:assert/strict';
import {
  mergeNativeConversationMessages,
  mergeNativeHydrationMessages,
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

run('mergeNativeHydrationMessages preserves a queued local turn missing from native history', () => {
  const existing = [
    makeMessage({ id: 'user-old', role: 'user', content: 'Run the APT comparison.' }),
    makeMessage({ id: 'assistant-old', content: 'The first side is still running.' }),
    makeMessage({ id: 'user-queued', role: 'user', content: '你现在再干嘛？' }),
    makeMessage({
      id: 'assistant-queued',
      content: 'Queued. Claude will start this message after the current run completes.',
      title: 'Claude queued',
      status: 'queued',
    }),
  ];
  const parsed = [
    makeMessage({ id: 'native-user-old', role: 'user', content: 'Run the APT comparison.' }),
    makeMessage({ id: 'native-assistant-new', content: 'The first side completed; starting the second.' }),
  ];

  const merged = mergeNativeHydrationMessages(existing, parsed);

  assert.deepEqual(
    merged.map((message) => message.id),
    ['native-user-old', 'native-assistant-new', 'user-queued', 'assistant-queued'],
  );
});

run('native hydration retains a completed result absent from JSONL across later turns and repeated refreshes', () => {
  const user = makeMessage({ id: 'baseline-user', role: 'user', content: 'Run six A-base baselines for the XMP comparison.' });
  const final = {
    ...makeMessage({ id: 'local-final', content: 'Six runs completed. FPS: 46.91 ± 0.19.\n\n| Run | FPS |\n| 2 | 46.64 |' }),
    completionOrigin: 'runtime' as const,
  };
  const followup = makeMessage({ id: 'followup', role: 'user', content: 'What should I compare after enabling XMP?' });
  const parsed = [
    user,
    makeMessage({ id: 'native-progress', content: 'The batch finished. Reading the six runs and the noise stats:' }),
    makeMessage({ id: 'task-notification', role: 'user', content: '<task-notification><task-id>baseline</task-id><status>completed</status></task-notification>' }),
    makeMessage({ id: 'edit-report', role: 'system', kind: 'tool_use', content: 'Edit baseline.md', status: 'success' }),
    followup,
    makeMessage({ id: 'followup-answer', content: 'Use the same replay and resolution.' }),
  ];
  const existing = [user, final, followup];
  const merged = mergeNativeHydrationMessages(existing, parsed);
  assert.equal(merged.find((message) => message.id === final.id)?.content, final.content);
  assert.ok(merged.indexOf(merged.find((message) => message.id === final.id)!) < merged.indexOf(followup));
  assert.deepEqual(mergeNativeHydrationMessages(merged, parsed), merged);
  assert.deepEqual(mergeNativeConversationMessages(existing, parsed), merged, 'resident recovery must use the same preservation rule');
});

run('native hydration deduplicates a local final once its native assistant blocks arrive', () => {
  const user = makeMessage({ id: 'user', role: 'user', content: 'Run the baseline.' });
  const final = { ...makeMessage({ id: 'local-final', content: 'Baseline complete.\n\nFPS 46.91.' }), completionOrigin: 'runtime' as const };
  const parsed = [
    user,
    makeMessage({ id: 'native-first', content: 'Baseline complete.' }),
    makeMessage({ id: 'native-last', content: 'FPS 46.91.' }),
  ];
  assert.equal(mergeNativeHydrationMessages([user, final], parsed), parsed);
});

run('native hydration does not resurrect completed replies from an abandoned user branch', () => {
  const oldUser = makeMessage({ id: 'old-user', role: 'user', content: 'Abandoned prompt.' });
  const final = { ...makeMessage({ id: 'local-final', content: 'Old final.' }), completionOrigin: 'runtime' as const };
  const parsed = [makeMessage({ id: 'new-user', role: 'user', content: 'Replacement prompt.' })];
  assert.equal(mergeNativeHydrationMessages([oldUser, final], parsed), parsed);
});

run('native hydration retains a recovered report with explicit provenance', () => {
  const user = makeMessage({ id: 'baseline-user', role: 'user', content: 'Run six baselines.' });
  const report = { ...makeMessage({ id: 'report', content: 'Recovered from baseline.md; original reply unavailable.\n\nFPS 46.91.' }), completionOrigin: 'recovered-report' as const };
  const parsed = [user, makeMessage({ id: 'edit-report', role: 'system', kind: 'tool_use', content: 'Edit baseline.md', status: 'success' })];
  const recovered = mergeNativeHydrationMessages([user, report], parsed);
  assert.deepEqual(recovered.at(-1), report);
  assert.deepEqual(mergeNativeHydrationMessages(recovered, parsed), recovered);
});

run('native hydration keeps richer legacy runtime text when native history is only its prefix', () => {
  const user = makeMessage({ id: 'user', role: 'user', content: 'Run the baseline.' });
  const final = makeMessage({ id: 'legacy-final', content: 'Reading the six runs.\n\nFPS 46.91 ± 0.19.' });
  const parsed = [user, makeMessage({ id: 'native-progress', kind: 'message', content: 'Reading the six runs.' })];
  assert.deepEqual(mergeNativeHydrationMessages([user, final], parsed).at(-1), final);
});

run('mergeNativeHydrationMessages uses prompt order when queued text repeats', () => {
  const existing = [
    makeMessage({ id: 'user-1', role: 'user', content: '继续' }),
    makeMessage({ id: 'assistant-1', content: 'Continuing the first run.' }),
    makeMessage({ id: 'user-2', role: 'user', content: '继续' }),
    makeMessage({ id: 'assistant-2', content: 'Continuing the second run.' }),
    makeMessage({ id: 'user-queued', role: 'user', content: '继续' }),
    makeMessage({ id: 'assistant-queued', title: 'Claude queued', status: 'queued' }),
  ];
  const parsed = [
    makeMessage({ id: 'native-user-1', role: 'user', content: '继续' }),
    makeMessage({ id: 'native-assistant-1', content: 'Continuing the first run.' }),
    makeMessage({ id: 'native-user-2', role: 'user', content: '继续' }),
    makeMessage({ id: 'native-assistant-2', content: 'The second run produced new output.' }),
  ];

  const merged = mergeNativeHydrationMessages(existing, parsed);

  assert.deepEqual(merged.slice(-2).map((message) => message.id), ['user-queued', 'assistant-queued']);
});

run('mergeNativeHydrationMessages drops the local pending pair once native history contains it', () => {
  const existing = [
    makeMessage({ id: 'user-old', role: 'user', content: 'Run the comparison.' }),
    makeMessage({ id: 'assistant-old', content: 'Running.' }),
    makeMessage({ id: 'user-queued', role: 'user', content: 'Summarize the current status.' }),
    makeMessage({ id: 'assistant-queued', title: 'Claude queued', status: 'queued' }),
  ];
  const parsed = [
    makeMessage({ id: 'native-user-old', role: 'user', content: 'Run the comparison.' }),
    makeMessage({ id: 'native-assistant-old', content: 'Finished.' }),
    makeMessage({
      id: 'native-user-queued',
      role: 'user',
      content: 'Pinned project instructions.\n\nSummarize the current status.\n\nAttached local files:\n- result.csv',
    }),
  ];

  const merged = mergeNativeHydrationMessages(existing, parsed);

  assert.equal(merged, parsed);
  assert.equal(merged.some((message) => message.id === 'assistant-queued'), false);
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

run('native hydration drops a runtime aggregate whose block join whitespace differs from native', () => {
  // The runtime accumulates every text block of a turn into one message using
  // whatever whitespace the model streamed, while native stores one record per
  // block. The block boundaries line up but the join whitespace differs, so a
  // naive "\n\n"-join substring check fails to recognize the duplicate.
  const user = makeMessage({ id: 'user', role: 'user', content: 'Investigate the motion blur flag.' });
  const final = {
    ...makeMessage({
      id: 'local-final',
      content: 'First finding about the flag.\nSecond finding after the search.\nThird finding with the fix.',
    }),
    completionOrigin: 'runtime' as const,
  };
  const parsed = [
    user,
    makeMessage({ id: 'native-1', content: 'First finding about the flag.' }),
    makeMessage({ id: 'native-tool', role: 'system', kind: 'tool_use', content: 'Grep flag', status: 'success' }),
    makeMessage({ id: 'native-2', content: 'Second finding after the search.' }),
    makeMessage({ id: 'native-3', content: 'Third finding with the fix.' }),
  ];

  const merged = mergeNativeHydrationMessages([user, final], parsed);
  assert.equal(merged, parsed, 'the runtime aggregate must be dropped once native holds every block');
  assert.equal(merged.some((message) => message.id === 'local-final'), false);
});

run('native hydration drops a runtime aggregate whose tail lands after a queued interjection', () => {
  // A queued user message can interrupt a turn; Claude records the turn's tail
  // blocks after the interjection's own reply. The runtime aggregate still holds
  // the whole original answer, so dedup must span past the next prompt in order.
  const userA = makeMessage({ id: 'user-a', role: 'user', content: 'Do task A.' });
  const final = {
    ...makeMessage({
      id: 'local-final',
      content: 'Working on A.\n\nStill on A.\n\nFinished A after your note.',
    }),
    completionOrigin: 'runtime' as const,
  };
  const interjection = makeMessage({ id: 'user-b', role: 'user', content: 'Do not rush the change.' });
  const parsed = [
    userA,
    makeMessage({ id: 'native-a1', content: 'Working on A.' }),
    makeMessage({ id: 'native-a2', content: 'Still on A.' }),
    interjection,
    makeMessage({ id: 'native-b1', content: 'Understood, holding the change.' }),
    makeMessage({ id: 'native-a3', content: 'Finished A after your note.' }),
  ];

  const merged = mergeNativeHydrationMessages([userA, final], parsed);
  assert.equal(merged, parsed, 'the aggregate is covered by A blocks even across the interjection reply');
  assert.equal(merged.some((message) => message.id === 'local-final'), false);
});

run('native hydration drops a delivered pending turn that compaction removed from the active branch', () => {
  const compactSummary = makeMessage({
    id: 'native-compact-summary',
    role: 'user',
    content: 'This session is being continued from a previous conversation that ran out of context.',
  });
  const followup = makeMessage({ id: 'native-followup', role: 'user', content: '你已经push完了吧' });
  const parsed = [
    compactSummary,
    makeMessage({ id: 'native-after-compact', content: 'push 成功。' }),
    followup,
    makeMessage({ id: 'native-followup-answer', content: '是的，push 已经完成。' }),
  ];
  // The prompt reached Claude before compaction, so native has its uuid on a
  // dropped branch, but the active branch starts at the compact summary.
  const deliveredPrompt = makeMessage({
    id: 'delivered-before-compact',
    role: 'user',
    content: '你把dev拉到最新，然后把这个提交到本地，我review一下',
  });
  const staleReply = makeMessage({
    id: 'local-live-reply',
    content: '我先看一下仓库里约定的 pull 流程和提交规范，再动手。',
    status: 'background',
  });
  const queuedPrompt = makeMessage({ id: 'still-queued', role: 'user', content: '再跑一次编译' });
  const queuedReply = makeMessage({ id: 'still-queued-reply', content: 'Queued.', status: 'queued' });
  const deliveredUserMessageIds = [compactSummary.id, followup.id, deliveredPrompt.id];

  for (const existing of [
    [deliveredPrompt, staleReply, followup, queuedPrompt, queuedReply],
    // A previous faulty merge already moved the stale pair to the tail.
    [...parsed, deliveredPrompt, staleReply, queuedPrompt, queuedReply],
  ]) {
    const merged = mergeNativeHydrationMessages(existing, parsed, deliveredUserMessageIds);
    assert.deepEqual(
      merged.map((message) => message.id),
      [...parsed.map((message) => message.id), 'still-queued', 'still-queued-reply'],
    );
  }
});
