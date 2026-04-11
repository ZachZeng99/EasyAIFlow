import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { configureRuntimePaths } from '../backend/runtimePaths.ts';
import { createClaudeInteractionState } from '../backend/claudeInteractionState.ts';
import { handleSendMessage, handleStopSession } from '../backend/claudeRpcOperations.ts';
import { createProject, findSession } from '../electron/sessionStore.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const run = async (name: string, fn: () => Promise<void>) => {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

const waitForReplies = async (sessionId: string, userSeq: number, expectedReplies: number, timeoutMs = 240000) => {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const session = await findSession(sessionId);
    if (session?.sessionKind === 'group') {
      const replies = (session.messages ?? []).filter(
        (message) => (message.seq ?? 0) > userSeq && message.role === 'assistant',
      );
      if (
        replies.length >= expectedReplies &&
        replies.every((message) => message.status === 'complete' || message.status === 'error')
      ) {
        return { session, replies };
      }
    }
    await sleep(1000);
  }

  throw new Error(`Timed out waiting for ${expectedReplies} replies after seq ${userSeq}.`);
};

await run('group chat roleplay stays conversational for Claude and Codex', async () => {
  const tempRoot = path.resolve(`.tmp-group-roleplay-${randomUUID().slice(0, 8)}`);
  const userDataPath = path.join(tempRoot, 'userData');
  const homePath = process.env.USERPROFILE ?? process.env.HOME ?? os.homedir();
  const workspacePath = path.join(tempRoot, 'workspace');

  await mkdir(userDataPath, { recursive: true });
  await mkdir(workspacePath, { recursive: true });

  configureRuntimePaths({ mode: 'web', userDataPath, homePath });

  const ctx = {
    broadcastEvent: (_event: Record<string, unknown>) => {},
    attachmentRoot: () => path.join(userDataPath, 'attachments'),
    claudeSettingsPath: () => path.join(homePath, '.claude', 'settings.json'),
    homePath: () => homePath,
  };

  try {
    const state = createClaudeInteractionState();
    const project = await createProject('RoleplaySmoke', workspacePath);
    let sessionId = project.session.id;

    await handleSendMessage(ctx as never, state, {
      sessionId,
      prompt: '@all 大家好',
      session: project.session,
      references: [],
      effort: 'medium',
    });

    let room = await findSession(sessionId);
    assert.equal(room?.sessionKind, 'group');
    if (!room) {
      throw new Error('Group room was not created.');
    }
    sessionId = room.id;

    const helloSeq = Math.max(...(room.messages ?? []).filter((message) => message.role === 'user').map((message) => message.seq ?? 0));
    const queuedHelloCodex = (room.messages ?? []).find(
      (message) =>
        (message.seq ?? 0) > helloSeq &&
        message.role === 'assistant' &&
        message.speakerLabel === 'Codex',
    );
    assert.ok(queuedHelloCodex, 'Codex placeholder was not created immediately for @all.');
    assert.notEqual(
      queuedHelloCodex.status,
      'complete',
      'Group send should return before the Codex room reply completes.',
    );
    const helloRound = await waitForReplies(sessionId, helloSeq, 2);
    const helloCodex = helloRound.replies.find((message) => message.speakerLabel === 'Codex');
    assert.ok(helloCodex?.content?.trim(), 'Codex greeting is empty.');
    assert.match(helloCodex?.content ?? '', /大家好|你好|hello|hi/i);

    await handleSendMessage(ctx as never, state, {
      sessionId,
      prompt: '@claude 20字内介绍这个项目',
      session: helloRound.session,
      references: [],
      effort: 'medium',
    });

    room = await findSession(sessionId);
    if (!room) {
      throw new Error('Room disappeared after Claude question.');
    }
    const claudeSeq = Math.max(...(room.messages ?? []).filter((message) => message.role === 'user').map((message) => message.seq ?? 0));
    const claudeRound = await waitForReplies(sessionId, claudeSeq, 1);
    const latestClaude = claudeRound.replies.find((message) => message.speakerLabel === 'Claude');
    assert.ok(latestClaude?.content?.trim(), 'Claude answer is empty.');
    assert.match(
      latestClaude?.content ?? '',
      /EasyAIFlow|项目|桌面客户端|AI编程|CLI|coding|desktop client|local AI/i,
    );

    await handleSendMessage(ctx as never, state, {
      sessionId,
      prompt: '@codex claude说的对不对',
      session: claudeRound.session,
      references: [],
      effort: 'medium',
    });

    room = await findSession(sessionId);
    if (!room) {
      throw new Error('Room disappeared after Codex follow-up.');
    }
    const codexSeq = Math.max(...(room.messages ?? []).filter((message) => message.role === 'user').map((message) => message.seq ?? 0));
    const codexRound = await waitForReplies(sessionId, codexSeq, 1);
    const latestCodex = [...codexRound.replies].reverse().find((message) => message.speakerLabel === 'Codex');
    assert.ok(latestCodex?.content?.trim(), 'Codex evaluation is empty.');
    assert.match(latestCodex?.content ?? '', /对|不对|不完全对|更准确|accurate|correct|wrong|not quite/i);
    assert.match(latestCodex?.content ?? '', /EasyAIFlow|客户端|CLI|本地 AI|desktop|client/i);
    await handleStopSession(ctx as never, state, { sessionId });
  } finally {
    try {
      await rm(tempRoot, { recursive: true, force: true });
    } catch {
      // Windows may keep the workspace busy briefly after stopping the child CLIs.
    }
  }
});
