import assert from 'node:assert/strict';
import {
  buildCodexArgs,
  buildCodexCommandTraceMessage,
  buildCodexFunctionCallTraceMessage,
  buildCodexPromptWithAttachments,
  buildCodexSpawnSpec,
} from '../backend/codexInteraction.ts';
import type { MessageAttachment, SessionSummary } from '../src/data/types.ts';

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

const makeSession = (overrides: Partial<SessionSummary> = {}): SessionSummary => ({
  id: overrides.id ?? 'session-1',
  title: overrides.title ?? 'Session 1',
  preview: overrides.preview ?? 'Preview',
  timeLabel: overrides.timeLabel ?? 'Just now',
  updatedAt: overrides.updatedAt ?? 1,
  provider: overrides.provider ?? 'codex',
  model: overrides.model ?? 'gpt-5.4',
  workspace: overrides.workspace ?? 'D:\\AIAgent\\EasyAIFlow-eaf_codex',
  projectId: overrides.projectId ?? 'project-1',
  projectName: overrides.projectName ?? 'EasyAIFlow',
  dreamId: overrides.dreamId ?? 'dream-1',
  dreamName: overrides.dreamName ?? 'Main Streamwork',
  claudeSessionId: overrides.claudeSessionId,
  codexThreadId: overrides.codexThreadId,
  sessionKind: overrides.sessionKind ?? 'standard',
  hidden: overrides.hidden ?? false,
  instructionPrompt: overrides.instructionPrompt,
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
    tracking: undefined,
    ahead: 0,
    behind: 0,
    dirty: false,
    changedFiles: [],
  },
});

run('buildCodexArgs builds a new exec invocation with prompt as a single positional argument', () => {
  const session = makeSession();
  const attachments: MessageAttachment[] = [
    {
      id: 'img-1',
      name: 'screenshot.png',
      path: 'D:\\tmp\\screenshot.png',
      mimeType: 'image/png',
      size: 123,
    },
  ];

  const args = buildCodexArgs(
    session,
    'Host behavior note: some UI mode transitions may be handled automatically.',
    attachments,
    'gpt-5.4',
  );

  assert.deepEqual(args, [
    'exec',
    '--json',
    '--full-auto',
    '-m',
    'gpt-5.4',
    '-i',
    'D:\\tmp\\screenshot.png',
    'Host behavior note: some UI mode transitions may be handled automatically.',
  ]);
});

run('buildCodexArgs can omit full-auto for chat-style codex turns', () => {
  const session = makeSession();
  const args = buildCodexArgs(session, 'hi', [], 'gpt-5.4', false);

  assert.deepEqual(args, [
    'exec',
    '--json',
    '-m',
    'gpt-5.4',
    'hi',
  ]);
});

run('buildCodexArgs can prepend disabled features before exec', () => {
  const session = makeSession();
  const args = buildCodexArgs(
    session,
    'hi',
    [],
    'gpt-5.4',
    false,
    false,
    ['shell_tool', 'plugins'],
  );

  assert.deepEqual(args, [
    '--disable',
    'shell_tool',
    '--disable',
    'plugins',
    'exec',
    '--json',
    '-m',
    'gpt-5.4',
    'hi',
  ]);
});

run('buildCodexArgs can include an output schema for structured chat replies', () => {
  const session = makeSession();
  const args = buildCodexArgs(
    session,
    'hi',
    [],
    'gpt-5.4',
    false,
    true,
    ['shell_tool'],
    'D:\\tmp\\codex-reply.schema.json',
  );

  assert.deepEqual(args, [
    '--disable',
    'shell_tool',
    'exec',
    '--json',
    '-m',
    'gpt-5.4',
    '--output-schema',
    'D:\\tmp\\codex-reply.schema.json',
    'hi',
  ]);
});

run('buildCodexArgs builds a resume invocation when a stored thread id exists', () => {
  const session = makeSession({ codexThreadId: 'thread-123' });
  const args = buildCodexArgs(session, 'continue', [], 'gpt-5.4-mini');

  assert.deepEqual(args, [
    'exec',
    'resume',
    '--json',
    '--full-auto',
    '-m',
    'gpt-5.4-mini',
    'thread-123',
    'continue',
  ]);
});

run('buildCodexArgs can ignore a stored thread id for stateless chat turns', () => {
  const session = makeSession({ codexThreadId: 'thread-123' });
  const args = buildCodexArgs(session, 'hi', [], 'gpt-5.4', false, false);

  assert.deepEqual(args, [
    'exec',
    '--json',
    '-m',
    'gpt-5.4',
    'hi',
  ]);
});

run('buildCodexSpawnSpec wraps codex in cmd.exe on Windows so prompts are not split by shell parsing', () => {
  const spec = buildCodexSpawnSpec(
    ['exec', '--json', '--full-auto', 'Host behavior note: some UI mode transitions may be handled automatically.'],
    'win32',
    'C:\\Windows\\System32\\cmd.exe',
  );

  assert.deepEqual(spec, {
    command: 'C:\\Windows\\System32\\cmd.exe',
    args: [
      '/d',
      '/s',
      '/c',
      'codex',
      'exec',
      '--json',
      '--full-auto',
      'Host behavior note: some UI mode transitions may be handled automatically.',
    ],
    shell: false,
  });
});

run('buildCodexPromptWithAttachments does not prepend the host behavior note to user prompts', () => {
  const prompt = buildCodexPromptWithAttachments(
    'hi',
    [],
    'Referenced session context',
    'You are in PBZ workspace.',
  );

  assert.equal(
    prompt,
    ['You are in PBZ workspace.', 'Referenced session context', 'hi'].join('\n\n'),
  );
  assert.equal(prompt.includes('Host behavior note:'), false);
});

run('buildCodexCommandTraceMessage maps command execution events into tool traces', () => {
  const running = buildCodexCommandTraceMessage({
    item: {
      id: 'item_0',
      type: 'command_execution',
      command: 'cmd /c ver',
      aggregated_output: '',
      exit_code: null,
    },
    status: 'running',
    timestamp: '4/7 01:00',
  });

  assert.deepEqual(running, {
    id: running?.id,
    role: 'system',
    kind: 'tool_use',
    timestamp: '4/7 01:00',
    title: 'Command',
    content: 'cmd /c ver',
    status: 'running',
  });

  const completed = buildCodexCommandTraceMessage({
    item: {
      id: 'item_0',
      type: 'command_execution',
      command: 'cmd /c ver',
      aggregated_output: '\r\nMicrosoft Windows [Version 10.0.26200.8037]\r\n',
      exit_code: 0,
    },
    status: 'success',
    previous: running ?? undefined,
  });

  assert.deepEqual(completed, {
    id: running?.id,
    role: 'system',
    kind: 'tool_use',
    timestamp: '4/7 01:00',
    title: 'Command',
    content: ['cmd /c ver', 'Microsoft Windows [Version 10.0.26200.8037]'].join('\n\n'),
    status: 'success',
  });
});

run('buildCodexFunctionCallTraceMessage maps tool calls and outputs into tool traces', () => {
  const running = buildCodexFunctionCallTraceMessage({
    item: {
      call_id: 'call_123',
      name: 'list_mcp_resource_templates',
      arguments: '{}',
    },
    status: 'running',
    timestamp: '4/7 01:10',
  });

  assert.deepEqual(running, {
    id: 'call_123',
    role: 'system',
    kind: 'tool_use',
    timestamp: '4/7 01:10',
    title: 'list_mcp_resource_templates',
    content: '{}',
    recordedDiff: undefined,
    status: 'running',
  });

  const completed = buildCodexFunctionCallTraceMessage({
    item: {
      call_id: 'call_123',
      output: '{"resourceTemplates":[]}',
    },
    status: 'success',
    previous: running ?? undefined,
  });

  assert.deepEqual(completed, {
    id: 'call_123',
    role: 'system',
    kind: 'tool_use',
    timestamp: '4/7 01:10',
    title: 'list_mcp_resource_templates',
    content: ['{}', '{"resourceTemplates":[]}'].join('\n\n'),
    recordedDiff: undefined,
    status: 'success',
  });
});

run('buildCodexFunctionCallTraceMessage keeps code edits as recorded code changes', () => {
  const patch = [
    '*** Begin Patch',
    '*** Update File: src/App.tsx',
    '@@',
    '-old',
    '+new',
    '*** End Patch',
  ].join('\n');

  const running = buildCodexFunctionCallTraceMessage({
    item: {
      call_id: 'call_patch',
      name: 'functions.apply_patch',
      arguments: JSON.stringify({ patch }),
    },
    status: 'running',
    timestamp: '4/7 01:12',
  });

  assert.deepEqual(running, {
    id: 'call_patch',
    role: 'system',
    kind: 'tool_use',
    timestamp: '4/7 01:12',
    title: 'apply_patch',
    content: 'src/App.tsx',
    recordedDiff: {
      filePath: 'src/App.tsx',
      kind: 'git',
      content: patch,
    },
    status: 'running',
  });

  const completed = buildCodexFunctionCallTraceMessage({
    item: {
      call_id: 'call_patch',
      output: '{"ok":true}',
    },
    status: 'success',
    previous: running ?? undefined,
  });

  assert.deepEqual(completed, {
    id: 'call_patch',
    role: 'system',
    kind: 'tool_use',
    timestamp: '4/7 01:12',
    title: 'apply_patch',
    content: 'src/App.tsx',
    recordedDiff: {
      filePath: 'src/App.tsx',
      kind: 'git',
      content: patch,
    },
    status: 'success',
  });
});
