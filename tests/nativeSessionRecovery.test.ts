import assert from 'node:assert/strict';
import {
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
