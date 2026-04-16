import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { configureRuntimePaths } from '../backend/runtimePaths.ts';
import { toClaudeProjectDirName } from '../electron/workspacePaths.ts';

const run = async (name: string, fn: () => Promise<void>) => {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

const importFreshSessionStore = async () =>
  import(`${pathToFileURL(path.resolve('electron/sessionStore.ts')).href}?t=${Date.now()}-${Math.random()}`);

await run('ensureGroupRoomSession creates a fresh primary member session without legacy prompt or thread state', async () => {
  const tempBase = path.resolve('.tmp-tests');
  await mkdir(tempBase, { recursive: true });
  const tempRoot = await mkdtemp(path.join(tempBase, 'session-store-group-room-'));
  const userDataPath = path.join(tempRoot, 'userData');
  const homePath = path.join(tempRoot, 'home');
  const projectRoot = path.join(tempRoot, 'workspace');
  const codexIndexPath = path.join(homePath, '.codex', 'session_index.jsonl');

  await mkdir(userDataPath, { recursive: true });
  await mkdir(homePath, { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  await mkdir(path.dirname(codexIndexPath), { recursive: true });
  await writeFile(
    codexIndexPath,
    `${JSON.stringify({
      id: 'thread-123',
      thread_name: 'Legacy room title',
      updated_at: '2026-04-07T10:00:00.000Z',
    })}\n`,
    'utf8',
  );

  const previousUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = homePath;
  configureRuntimePaths({ mode: 'web', userDataPath, homePath });

  try {
    const sessionStore = await importFreshSessionStore();
    const projectResult = await sessionStore.createProject('Smoke', projectRoot);
    const created = await sessionStore.createSession(projectResult.session.id, false, 'codex');

    await sessionStore.setSessionRuntime(created.session.id, {
      codexThreadId: 'thread-123',
      model: 'gpt-5.4-mini',
    });
    await sessionStore.updateSessionRecord(created.session.id, (session: {
      instructionPrompt?: string;
      messages: Array<Record<string, unknown>>;
    }) => {
      session.instructionPrompt = 'Legacy AGENTS prompt';
      session.messages.push({
        id: 'legacy-user',
        role: 'user',
        timestamp: '4/7 10:00',
        title: 'Legacy prompt',
        content: 'Check the repo',
        status: 'complete',
      });
    });

    const room = await sessionStore.ensureGroupRoomSession(created.session.id);
    const primaryParticipant = room.group?.kind === 'room'
      ? room.group.participants.find((participant: { id: string }) => participant.id === 'codex')
      : undefined;
    const primaryMember = primaryParticipant
      ? await sessionStore.findSession(primaryParticipant.backingSessionId)
      : null;

    assert.equal(room.sessionKind, 'group');
    assert.equal(room.instructionPrompt, undefined);
    assert.equal(primaryParticipant?.lastAppliedRoomSeq, 1);
    assert.equal(primaryMember?.sessionKind, 'group_member');
    assert.equal(primaryMember?.title, `[Group] ${room.title}`);
    assert.equal(primaryMember?.instructionPrompt, undefined);
    assert.equal(primaryMember?.codexThreadId, 'thread-123');
    assert.equal(primaryMember?.model, 'gpt-5.4-mini');
    assert.equal(primaryMember?.messages.length, 0);

    const updatedIndex = JSON.parse((await readFile(codexIndexPath, 'utf8')).trim()) as {
      id?: string;
      thread_name?: string;
    };
    assert.equal(updatedIndex.id, 'thread-123');
    assert.equal(updatedIndex.thread_name, primaryMember?.title);
  } finally {
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
  }
});

await run('ensureGroupRoomBackingSessions clears legacy prompt injection on existing Codex group members', async () => {
  const tempBase = path.resolve('.tmp-tests');
  await mkdir(tempBase, { recursive: true });
  const tempRoot = await mkdtemp(path.join(tempBase, 'session-store-group-room-clear-prompt-'));
  const userDataPath = path.join(tempRoot, 'userData');
  const homePath = path.join(tempRoot, 'home');
  const projectRoot = path.join(tempRoot, 'workspace');

  await mkdir(userDataPath, { recursive: true });
  await mkdir(homePath, { recursive: true });
  await mkdir(projectRoot, { recursive: true });

  const previousUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = homePath;
  configureRuntimePaths({ mode: 'web', userDataPath, homePath });

  try {
    const sessionStore = await importFreshSessionStore();
    const projectResult = await sessionStore.createProject('Smoke', projectRoot);
    const room = await sessionStore.ensureGroupRoomSession(projectResult.session.id);
    const codexParticipant =
      room.group?.kind === 'room'
        ? room.group.participants.find((participant: { id: string }) => participant.id === 'codex')
        : undefined;
    if (!codexParticipant) {
      throw new Error('Codex participant was not created.');
    }

    await sessionStore.updateSessionRecord(codexParticipant.backingSessionId, (session: {
      instructionPrompt?: string;
    }) => {
      session.instructionPrompt = 'Legacy room roleplay prompt';
    });

    const healed = await sessionStore.ensureGroupRoomBackingSessions(room.id);
    const healedCodexParticipant =
      healed.group?.kind === 'room'
        ? healed.group.participants.find((participant: { id: string }) => participant.id === 'codex')
        : undefined;
    const healedBacking = healedCodexParticipant
      ? await sessionStore.findSession(healedCodexParticipant.backingSessionId)
      : null;

    assert.equal(healedBacking?.instructionPrompt, undefined);
  } finally {
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
  }
});

await run('ensureGroupRoomBackingSessions recreates missing hidden members for an existing group room', async () => {
  const tempBase = path.resolve('.tmp-tests');
  await mkdir(tempBase, { recursive: true });
  const tempRoot = await mkdtemp(path.join(tempBase, 'session-store-group-room-heal-'));
  const userDataPath = path.join(tempRoot, 'userData');
  const homePath = path.join(tempRoot, 'home');
  const projectRoot = path.join(tempRoot, 'workspace');

  await mkdir(userDataPath, { recursive: true });
  await mkdir(homePath, { recursive: true });
  await mkdir(projectRoot, { recursive: true });

  const previousUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = homePath;
  configureRuntimePaths({ mode: 'web', userDataPath, homePath });

  try {
    const sessionStore = await importFreshSessionStore();
    const projectResult = await sessionStore.createProject('Smoke', projectRoot);
    const room = await sessionStore.ensureGroupRoomSession(projectResult.session.id);
    const participantIds =
      room.group?.kind === 'room'
        ? room.group.participants.map((participant: { backingSessionId: string }) => participant.backingSessionId)
        : [];

    for (const hiddenId of participantIds) {
      await sessionStore.deleteSession(hiddenId);
    }

    const healed = await sessionStore.ensureGroupRoomBackingSessions(room.id);
    assert.equal(healed.sessionKind, 'group');
    assert.equal(healed.group?.kind, 'room');
    assert.equal(healed.group?.participants.length, 2);

    for (const participant of healed.group?.kind === 'room' ? healed.group.participants : []) {
      const backing = await sessionStore.findSession(participant.backingSessionId);
      assert.equal(backing?.sessionKind, 'group_member');
      assert.equal(backing?.hidden, true);
    }
  } finally {
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
  }
});

await run('renameEntity keeps group backing session titles aligned with the group room title', async () => {
  const tempBase = path.resolve('.tmp-tests');
  await mkdir(tempBase, { recursive: true });
  const tempRoot = await mkdtemp(path.join(tempBase, 'session-store-group-room-rename-'));
  const userDataPath = path.join(tempRoot, 'userData');
  const homePath = path.join(tempRoot, 'home');
  const projectRoot = path.join(tempRoot, 'workspace');
  const codexIndexPath = path.join(homePath, '.codex', 'session_index.jsonl');
  const claudeProjectsDir = path.join(
    homePath,
    '.claude',
    'projects',
    toClaudeProjectDirName(projectRoot) ?? 'workspace',
  );
  const claudeSessionId = 'claude-room-session';
  const claudeSessionPath = path.join(claudeProjectsDir, `${claudeSessionId}.jsonl`);

  await mkdir(userDataPath, { recursive: true });
  await mkdir(path.dirname(codexIndexPath), { recursive: true });
  await mkdir(claudeProjectsDir, { recursive: true });
  await mkdir(homePath, { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  await writeFile(codexIndexPath, '', 'utf8');
  await writeFile(
    claudeSessionPath,
    `${JSON.stringify({
      type: 'custom-title',
      customTitle: '[Group] Smoke',
      sessionId: claudeSessionId,
    })}\n`,
    'utf8',
  );

  const previousUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = homePath;
  configureRuntimePaths({ mode: 'web', userDataPath, homePath });

  try {
    const sessionStore = await importFreshSessionStore();
    const projectResult = await sessionStore.createProject('Smoke', projectRoot);
    const room = await sessionStore.ensureGroupRoomSession(projectResult.session.id);
    const codexParticipant =
      room.group?.kind === 'room'
        ? room.group.participants.find((participant: { id: string }) => participant.id === 'codex')
        : undefined;
    const claudeParticipant =
      room.group?.kind === 'room'
        ? room.group.participants.find((participant: { id: string }) => participant.id === 'claude')
        : undefined;
    if (!codexParticipant || !claudeParticipant) {
      throw new Error('Group participants were not created.');
    }

    await sessionStore.setSessionRuntime(codexParticipant.backingSessionId, {
      codexThreadId: 'codex-room-thread',
      model: 'gpt-5.4-mini',
    });
    await sessionStore.setSessionRuntime(claudeParticipant.backingSessionId, {
      claudeSessionId,
      model: 'opus[1m]',
    });

    await sessionStore.renameEntity('session', room.id, 'Renamed room');

    const codexBacking = await sessionStore.findSession(codexParticipant.backingSessionId);
    const claudeBacking = await sessionStore.findSession(claudeParticipant.backingSessionId);
    assert.equal(codexBacking?.title, '[Group] Renamed room');
    assert.equal(claudeBacking?.title, '[Group] Renamed room');

    const updatedIndex = await readFile(codexIndexPath, 'utf8');
    assert.match(updatedIndex, /"id":"codex-room-thread"/);
    assert.match(updatedIndex, /"thread_name":"\[Group\] Renamed room"/);

    const updatedClaudeSession = await readFile(claudeSessionPath, 'utf8');
    assert.match(updatedClaudeSession, /"sessionId":"claude-room-session"/);
    assert.match(updatedClaudeSession, /"customTitle":"\[Group\] Renamed room"/);
  } finally {
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
  }
});
