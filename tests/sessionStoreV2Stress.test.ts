import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ConversationMessage, SessionRecord } from '../src/data/types.js';
import type { SessionStoreAppState } from '../electron/sessionStoreMerge.js';
import {
  getSessionStoreV2Paths,
  migrateSessionStoreV2,
  openSessionStoreV2,
} from '../electron/sessionStoreV2.js';

const run = async (name: string, fn: () => Promise<void>) => {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

const makeMessage = (id: string, content: string): ConversationMessage => ({
  id,
  role: 'assistant',
  timestamp: 'Just now',
  title: id,
  content,
  status: 'streaming',
});

const makeSession = (id: string, content: string): SessionRecord => ({
  id,
  title: id,
  preview: '',
  timeLabel: 'Just now',
  updatedAt: 1,
  provider: 'codex',
  model: 'gpt-5',
  workspace: 'X:\\workspace',
  projectId: 'project-1',
  projectName: 'Project',
  dreamId: 'dream-1',
  dreamName: 'Dream',
  sessionKind: 'standard',
  hidden: false,
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
    ahead: 0,
    behind: 0,
    dirty: false,
    changedFiles: [],
  },
  messages: [makeMessage(`${id}-message`, content)],
});

await run('repeated active-session checkpoints never rewrite unrelated session snapshots', async () => {
  const base = path.resolve('.tmp-tests');
  await mkdir(base, { recursive: true });
  const userDataPath = await mkdtemp(path.join(base, 'session-store-v2-stress-'));
  const sessions = Array.from({ length: 150 }, (_, index) =>
    makeSession(`session-${index}`, `${index}:`.padEnd(32 * 1024, 'x')),
  );
  const state: SessionStoreAppState = {
    projects: [
      {
        id: 'project-1',
        name: 'Project',
        rootPath: 'X:\\workspace',
        dreams: [{ id: 'dream-1', name: 'Dream', sessions }],
      },
    ],
    deletedImports: { claudeSessionIds: [], codexThreadIds: [] },
  };
  const options = {
    maxMessages: 400,
    compactionEventCount: 16,
    compactionBytes: 256 * 1024,
    indexDebounceMs: 5,
  };
  const store = await migrateSessionStoreV2(userDataPath, state, options);
  const unrelatedBefore = new Map<string, { mtimeMs: number; size: number }>();
  for (const target of sessions.slice(1)) {
    const metaStat = await stat(getSessionStoreV2Paths(userDataPath, target.id).metaPath);
    unrelatedBefore.set(target.id, { mtimeMs: metaStat.mtimeMs, size: metaStat.size });
  }

  const active = sessions[0];
  const activeMessage = active.messages[0];
  assert.ok(activeMessage);
  for (let index = 0; index < 100; index += 1) {
    activeMessage.content += `checkpoint-${index};`;
    active.updatedAt = index + 2;
    await store.persist(state, {
      sessionMutations: [
        {
          type: 'upsert-message',
          sessionId: active.id,
          message: activeMessage,
        },
      ],
      immediateIndex: false,
    });
  }
  await store.flush(state);

  for (const target of sessions.slice(1)) {
    const before = unrelatedBefore.get(target.id);
    const after = await stat(getSessionStoreV2Paths(userDataPath, target.id).metaPath);
    assert.deepEqual({ mtimeMs: after.mtimeMs, size: after.size }, before);
  }
  const loaded = await openSessionStoreV2(userDataPath, options);
  const loadedActive = loaded?.state.projects[0]?.dreams[0]?.sessions[0] as SessionRecord | undefined;
  assert.deepEqual(loadedActive?.messages, []);
  assert.equal(
    (await loaded?.store.readMessagePage(active.id))?.messages[0]?.content,
    activeMessage.content,
  );
  const rootEntries = await readdir(userDataPath);
  assert.equal(rootEntries.some((entry) => entry.startsWith('easyaiflow-sessions.json.')), false);
});

await run('interleaved session queues keep Claude, Codex, group, and awaiting histories independent', async () => {
  const base = path.resolve('.tmp-tests');
  await mkdir(base, { recursive: true });
  const userDataPath = await mkdtemp(path.join(base, 'session-store-v2-parallel-'));
  const sessions = [
    makeSession('claude-active', 'claude'),
    makeSession('codex-active', 'codex'),
    makeSession('group-room', 'group'),
    makeSession('group-member', 'member'),
    makeSession('awaiting-reply', 'awaiting'),
    makeSession('history-a', 'a'),
    makeSession('history-b', 'b'),
  ];
  const state: SessionStoreAppState = {
    projects: [{
      id: 'project-1',
      name: 'Project',
      rootPath: 'X:\\workspace',
      dreams: [{ id: 'dream-1', name: 'Dream', sessions }],
    }],
    deletedImports: { claudeSessionIds: [], codexThreadIds: [] },
  };
  const options = {
    maxMessages: 0,
    compactionEventCount: 9,
    compactionBytes: 64 * 1024,
    indexDebounceMs: 2,
  };
  const store = await migrateSessionStoreV2(userDataPath, state, options);
  const active = sessions.slice(0, 4);

  await Promise.all([
    ...active.map(async (target) => {
      const streaming = target.messages[0]!;
      for (let index = 0; index < 30; index += 1) {
        streaming.content = `${target.id}-checkpoint-${index}`;
        await store.persist(state, {
          sessionMutations: [
            { type: 'upsert-message', sessionId: target.id, message: { ...streaming } },
            {
              type: 'append-messages',
              sessionId: target.id,
              messages: [makeMessage(`${target.id}-append-${index}`, `${target.id}-${index}`)],
            },
          ],
          immediateIndex: false,
        });
      }
    }),
    (async () => {
      for (let index = 0; index < 12; index += 1) {
        const awaiting = await store.readMessagePage('awaiting-reply');
        const historyA = await store.readMessagePage('history-a');
        const historyB = await store.readMessagePage('history-b');
        assert.equal(awaiting.messages[0]?.content, 'awaiting');
        assert.equal(historyA.messages[0]?.content, 'a');
        assert.equal(historyB.messages[0]?.content, 'b');
      }
    })(),
  ]);
  await store.flush(state);

  const reopened = await openSessionStoreV2(userDataPath, options);
  assert.ok(reopened);
  for (const target of active) {
    const page = await reopened!.store.readMessagePage(target.id);
    assert.equal(page.messages.length, 31, target.id);
    assert.equal(page.messages[0]?.content, `${target.id}-checkpoint-29`, target.id);
    assert.equal(page.messages.at(-1)?.id, `${target.id}-append-29`, target.id);
  }
  assert.equal(
    (await reopened!.store.readMessagePage('awaiting-reply')).messages[0]?.content,
    'awaiting',
  );
});
