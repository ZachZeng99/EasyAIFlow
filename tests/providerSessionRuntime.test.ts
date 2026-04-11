import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { configureRuntimePaths } from '../backend/runtimePaths.ts';
import {
  providerSessionRuntimes,
  resolveProviderSessionRuntime,
  resolveProviderSessionRuntimeProvider,
} from '../backend/providerSessionRuntime.ts';
import type { SessionSummary } from '../src/data/types.ts';
import { createProject, createSession } from '../electron/sessionStore.ts';

const run = async (name: string, fn: () => Promise<void>) => {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

const makeFallbackSession = (provider: 'claude' | 'codex'): SessionSummary => ({
  id: 'missing-session',
  title: 'Missing session',
  preview: 'Preview',
  timeLabel: 'Just now',
  updatedAt: 1,
  provider,
  model: provider === 'codex' ? 'gpt-5.4' : 'opus[1m]',
  workspace: 'D:\\AIAgent\\EasyAIFlow-eaf_codex',
  projectId: 'project-1',
  projectName: 'EasyAIFlow',
  dreamId: 'dream-1',
  dreamName: 'Main Streamwork',
  claudeSessionId: undefined,
  codexThreadId: undefined,
  sessionKind: 'standard',
  hidden: false,
  instructionPrompt: undefined,
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
});

await run('provider session runtimes advertise resident vs one-shot capabilities', async () => {
  assert.deepEqual(providerSessionRuntimes.claude.capabilities, {
    residentSession: true,
    interactiveControl: true,
    disconnectBehavior: 'resident',
  });
  assert.deepEqual(providerSessionRuntimes.codex.capabilities, {
    residentSession: false,
    interactiveControl: false,
    disconnectBehavior: 'stop',
  });
});

await run('resolveProviderSessionRuntime resolves stored Claude and Codex sessions', async () => {
  const tempBase = path.resolve('.tmp-tests');
  await mkdir(tempBase, { recursive: true });
  const tempRoot = await mkdtemp(path.join(tempBase, 'provider-session-runtime-'));
  const userDataPath = path.join(tempRoot, 'userData');
  const homePath = path.join(tempRoot, 'home');
  const projectRoot = path.join(tempRoot, 'workspace');

  await mkdir(userDataPath, { recursive: true });
  await mkdir(homePath, { recursive: true });
  await mkdir(projectRoot, { recursive: true });

  configureRuntimePaths({ mode: 'web', userDataPath, homePath });

  try {
    const created = await createProject('Runtime routing', projectRoot);
    const claudeRuntime = await resolveProviderSessionRuntime(created.session.id);
    assert.equal(claudeRuntime.provider, 'claude');
    assert.equal(claudeRuntime.capabilities.residentSession, true);

    const codexCreated = await createSession(created.session.id, false, 'codex');
    const codexProvider = await resolveProviderSessionRuntimeProvider(codexCreated.session.id);
    const codexRuntime = await resolveProviderSessionRuntime(codexCreated.session.id);
    assert.equal(codexProvider, 'codex');
    assert.equal(codexRuntime.provider, 'codex');
    assert.equal(codexRuntime.capabilities.disconnectBehavior, 'stop');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

await run('resolveProviderSessionRuntime falls back to the supplied session summary', async () => {
  const fallbackProvider = await resolveProviderSessionRuntimeProvider('missing-session', makeFallbackSession('codex'));
  const fallbackRuntime = await resolveProviderSessionRuntime('missing-session', makeFallbackSession('codex'));

  assert.equal(fallbackProvider, 'codex');
  assert.equal(fallbackRuntime.provider, 'codex');
});
