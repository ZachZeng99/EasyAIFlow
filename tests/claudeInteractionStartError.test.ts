import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { ClaudeInteractionContext } from '../backend/claudeInteractionContext.ts';
import {
  markPreparedClaudeRunErrored,
  prepareClaudeRun,
} from '../backend/claudeInteraction.ts';
import { createClaudeInteractionState } from '../backend/claudeInteractionState.ts';
import {
  configureRuntimePaths,
  getRuntimePaths,
} from '../backend/runtimePaths.ts';
import {
  createProject,
  findSession,
} from '../electron/sessionStore.ts';
import type { ClaudeStreamEvent } from '../src/data/types.ts';

const run = async (name: string, fn: () => Promise<void>) => {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

await run('markPreparedClaudeRunErrored converts a pending assistant placeholder into a visible error', async () => {
  const tempBase = path.resolve('.tmp-tests');
  await mkdir(tempBase, { recursive: true });
  const tempRoot = await mkdtemp(path.join(tempBase, 'claude-run-start-error-'));
  const userDataPath = path.join(tempRoot, 'userData');
  const homePath = path.join(tempRoot, 'home');
  const projectRoot = path.join(tempRoot, 'workspace');
  const previousRuntimePaths = getRuntimePaths();
  const previousUserProfile = process.env.USERPROFILE;
  const events: ClaudeStreamEvent[] = [];

  await mkdir(userDataPath, { recursive: true });
  await mkdir(homePath, { recursive: true });
  await mkdir(projectRoot, { recursive: true });

  process.env.USERPROFILE = homePath;
  configureRuntimePaths({ mode: 'web', userDataPath, homePath });

  try {
    const ctx: ClaudeInteractionContext = {
      broadcastEvent: (event) => {
        events.push(event);
      },
      attachmentRoot: () => path.join(userDataPath, 'attachments'),
      claudeSettingsPath: () => path.join(homePath, '.claude', 'settings.json'),
      homePath: () => homePath,
    };
    const created = await createProject('Start error', projectRoot);
    const state = createClaudeInteractionState();

    const prepared = await prepareClaudeRun(
      ctx,
      state,
      created.session.id,
      'Why did Claude not start?',
      [],
      created.session,
    );

    await markPreparedClaudeRunErrored(
      ctx,
      prepared,
      new Error('Claude stdin is not writable.'),
    );

    const session = await findSession(created.session.id);
    const assistant = session?.messages.find(
      (message) => message.id === prepared.assistantMessageId,
    );

    assert.equal(assistant?.status, 'error');
    assert.equal(assistant?.title, 'Claude error');
    assert.equal(assistant?.content, 'Claude stdin is not writable.');
    assert.equal(session?.preview, 'Claude stdin is not writable.');
    assert.equal(session?.timeLabel, 'Just now');
    assert.deepEqual(events.at(-1), {
      type: 'error',
      sessionId: created.session.id,
      messageId: prepared.assistantMessageId,
      error: 'Claude stdin is not writable.',
    });
  } finally {
    configureRuntimePaths(previousRuntimePaths);
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});
