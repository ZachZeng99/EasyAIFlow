import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { configureRuntimePaths } from '../backend/runtimePaths.ts';
import type { ConversationMessage } from '../src/data/types.ts';

await mkdir('.tmp-tests', { recursive: true });
const root = await mkdtemp(path.resolve('.tmp-tests', 'runtime-authority-'));
const data = path.join(root, 'data');
const home = path.join(root, 'home');
const workspace = path.join(root, 'project', 'child');
await mkdir(data);
await mkdir(workspace, { recursive: true });
const nativeDirectory = path.join(home, '.codex', 'sessions');
await mkdir(nativeDirectory, { recursive: true });
await writeFile(path.join(data, 'easyaiflow-sessions.json'), JSON.stringify({ projects: [], deletedImports: { claudeSessionIds: [], codexThreadIds: [] } }));
configureRuntimePaths({ userDataPath: data, homePath: home, mode: 'web' });
const freshStore = () => import(`${pathToFileURL(path.resolve('electron/sessionStore.ts')).href}?authority=${Math.random()}`);
let store = await freshStore();
const project = await store.createProject('Child', workspace);
const created = await store.createSessionInStreamwork(project.session.dreamId, 'Owned', false, 'codex');
const id = created.session.id;
await store.setSessionRuntime(id, { codexThreadId: 'owned-thread' });
const messages: ConversationMessage[] = [
  { id: 'eaf-user', role: 'user', title: 'Prompt', timestamp: 'now', content: 'hello', status: 'complete' },
  { id: 'eaf-reply', role: 'assistant', title: 'Reply', timestamp: 'now', content: 'EAF_SYNC_OK', status: 'complete' },
];
await store.appendMessagesToSession(id, messages, 'EAF_SYNC_OK', 'now');
const original = await store.getSessionRecordForBootstrap(id);
const lines = [
  { type: 'session_meta', payload: { id: 'owned-thread', cwd: workspace } },
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] } },
  { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'EAF_SYNC_OK' }] } },
];
await writeFile(path.join(nativeDirectory, 'rollout-owned.jsonl'), lines.map((line) => JSON.stringify({ ...line, timestamp: new Date().toISOString() })).join('\n') + '\n');
await store.getProjectsForBootstrap();
const refreshed = await store.getSessionRecordForBootstrap(id);
assert.deepEqual(refreshed?.messages.map((message: ConversationMessage) => message.id), ['eaf-user', 'eaf-reply']);
assert.equal(refreshed?.messageRevision, original?.messageRevision);
console.log('PASS native catalog refresh preserves runtime-owned IDs and revisions');

await store.flushPendingSave();
store = await freshStore();
const reopened = await store.getSessionRecordForBootstrap(id);
assert.equal(reopened?.historyAuthority, 'runtime');
assert.deepEqual(reopened?.messages.map((message: ConversationMessage) => message.id), ['eaf-user', 'eaf-reply']);
console.log('PASS runtime history ownership survives a store restart');

await store.createProject('Parent', path.dirname(workspace));
const projects = await store.getProjectsForBootstrap();
const copies = projects.flatMap((p) => p.dreams.flatMap((d) => d.sessions)).filter((session) => session.codexThreadId === 'owned-thread');
assert.equal(copies.length, 1);
assert.equal(copies[0].id, id);
console.log('PASS overlapping project trees do not import a second copy of a managed native thread');
await store.flushPendingSave();
