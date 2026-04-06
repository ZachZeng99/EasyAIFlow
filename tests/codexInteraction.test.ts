import assert from 'node:assert/strict';
import {
  buildCodexArgs,
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
  harness: overrides.harness,
  harnessState: overrides.harnessState,
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
