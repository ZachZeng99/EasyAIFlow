import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
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

const message = (id: string): ConversationMessage => ({
  id,
  role: id.startsWith('user') ? 'user' : 'assistant',
  timestamp: 'Just now',
  title: id,
  content: `content:${id}`,
  status: 'complete',
});

const session = (
  id: string,
  provider: 'claude' | 'codex',
  messages: ConversationMessage[],
): SessionRecord => ({
  id,
  title: id,
  preview: messages.at(-1)?.content ?? '',
  timeLabel: 'Just now',
  updatedAt: 1,
  provider,
  model: provider === 'claude' ? 'opus' : 'gpt-5',
  workspace: 'X:\\workspace',
  projectId: 'project-1',
  projectName: 'Project',
  dreamId: 'dream-1',
  dreamName: 'Dream',
  claudeSessionId: provider === 'claude' ? `claude-${id}` : undefined,
  codexThreadId: provider === 'codex' ? `codex-${id}` : undefined,
  sessionKind: 'standard',
  hidden: false,
  groups: [],
  contextReferences: [],
  tokenUsage: {
    contextWindow: 100,
    used: 10,
    input: 7,
    output: 3,
    cached: 0,
    windowSource: 'runtime',
  },
  branchSnapshot: {
    branch: 'main',
    ahead: 0,
    behind: 0,
    dirty: false,
    changedFiles: [],
  },
  messages,
});

const stateWithSessions = (sessions: SessionRecord[]): SessionStoreAppState => ({
  projects: [
    {
      id: 'project-1',
      name: 'Project',
      rootPath: 'X:\\workspace',
      dreams: [
        {
          id: 'dream-1',
          name: 'Dream',
          sessions,
        },
      ],
    },
  ],
  deletedImports: {
    claudeSessionIds: ['deleted-claude'],
    codexThreadIds: ['deleted-codex'],
  },
});

const options = {
  maxMessages: 400,
  compactionEventCount: 64,
  compactionBytes: 1024 * 1024,
};

await run('migrates V1 state without changing the legacy file', async () => {
  const base = path.resolve('.tmp-tests');
  await mkdir(base, { recursive: true });
  const userDataPath = await mkdtemp(path.join(base, 'session-store-v2-migration-'));
  const legacyPath = path.join(userDataPath, 'easyaiflow-sessions.json');
  const state = stateWithSessions([
    session('session-claude', 'claude', [message('user-1'), message('assistant-1')]),
    session('session-codex', 'codex', [message('user-2'), message('assistant-2')]),
  ]);
  const legacyBytes = `${JSON.stringify(state, null, 2)}\n`;
  await writeFile(legacyPath, legacyBytes, 'utf8');

  await migrateSessionStoreV2(userDataPath, state, options);
  const loaded = await openSessionStoreV2(userDataPath, options);
  const loadedSessions = loaded?.state.projects[0]?.dreams[0]?.sessions as SessionRecord[] | undefined;

  assert.equal(await readFile(legacyPath, 'utf8'), legacyBytes);
  assert.deepEqual(loadedSessions?.map((item) => item.id), ['session-claude', 'session-codex']);
  assert.equal(loadedSessions?.[0]?.claudeSessionId, 'claude-session-claude');
  assert.equal(loadedSessions?.[1]?.codexThreadId, 'codex-session-codex');
  assert.deepEqual(loadedSessions?.map((item) => item.messages.length), [0, 0]);
  assert.deepEqual(loadedSessions?.map((item) => item.messagesLoaded), [false, false]);
  assert.deepEqual(
    (await loaded!.store.readMessagePage('session-claude')).messages.map((item) => item.id),
    ['user-1', 'assistant-1'],
  );
  assert.deepEqual(
    (await loaded!.store.readMessagePage('session-codex')).messages.map((item) => item.id),
    ['user-2', 'assistant-2'],
  );
  assert.deepEqual(loaded?.state.deletedImports, state.deletedImports);
});

await run('does not activate V2 when staged verification finds duplicate session identities', async () => {
  const base = path.resolve('.tmp-tests');
  await mkdir(base, { recursive: true });
  const userDataPath = await mkdtemp(path.join(base, 'session-store-v2-invalid-migration-'));
  const duplicate = session('duplicate-id', 'codex', [message('assistant-1')]);
  const state = stateWithSessions([
    duplicate,
    {
      ...duplicate,
      title: 'Duplicate copy',
      messages: [message('assistant-2')],
    },
  ]);

  await assert.rejects(
    () => migrateSessionStoreV2(userDataPath, state, options),
    /migration verification failed/i,
  );
  await assert.rejects(() => access(getSessionStoreV2Paths(userDataPath).rootPath));
  const entries = await readdir(userDataPath);
  assert.equal(entries.some((entry) => entry.includes('.migrating-')), false);
});

await run('preserves legacy histories larger than the old monolithic-store cap', async () => {
  const base = path.resolve('.tmp-tests');
  await mkdir(base, { recursive: true });
  const userDataPath = await mkdtemp(path.join(base, 'session-store-v2-full-history-'));
  const messages = Array.from({ length: 450 }, (_, index) => message(`assistant-${index}`));
  const state = stateWithSessions([session('long-session', 'codex', messages)]);

  await migrateSessionStoreV2(userDataPath, state, { ...options, maxMessages: 0 });
  const loaded = await openSessionStoreV2(userDataPath, { ...options, maxMessages: 0 });
  const loadedSession = loaded?.state.projects[0]?.dreams[0]?.sessions[0] as SessionRecord | undefined;
  assert.equal(loadedSession?.messages.length, 0);
  const newest = await loaded!.store.readMessagePage('long-session');
  assert.equal(newest.messages.length, 50);
  assert.equal(newest.messages[0]?.id, 'assistant-400');
  assert.equal(newest.messages.at(-1)?.id, 'assistant-449');
  assert.equal(newest.hasMoreBefore, true);
});
